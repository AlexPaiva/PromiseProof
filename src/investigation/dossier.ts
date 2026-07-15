import { DIAGNOSTIC_REPLAYS } from '../shared/diagnostics.js';
import { evaluatePromise } from '../shared/evaluator.js';
import type { PromiseClauseResult, PromiseEvidence } from '../shared/types.js';
import {
  DIAGNOSTIC_REPLAY_IDS,
  DOSSIER_VERSION,
  OFF_CLAUSE_IDS,
  RELEVANT_EVENT_NAMES,
  type EvidenceReferenceV1,
  type InvestigationDossierV1,
  type NormalizedReplayOutputV1,
  type OffClauseId,
  type PreferenceRoundtripReplayReportV1,
  type RelevantEventName,
  type StartupOrderReplayReportV1,
} from './contracts.js';
import {
  investigationDossierV1Schema,
  normalizedReplayOutputV1Schema,
  preferenceRoundtripReplayReportV1Schema,
  promiseEvidenceSchema,
  startupOrderReplayReportV1Schema,
} from './schemas.js';
import { deepFreeze } from './immutable.js';

export const CANONICAL_PROMISE_STATEMENT =
  'When activity-based personalization is OFF, no identifiable activity reaches the recommendation service, the feed remains functional using contextual recommendations, and the preference survives a reload.';

const CLAUSE_DESCRIPTIONS: Record<OffClauseId, string> = {
  no_identifiable_activity:
    'No identifiable activity reaches the recommendation service while the choice is OFF.',
  contextual_feed_functional:
    'The recommendation feed remains functional in contextual mode while the choice is OFF.',
  preference_survives_reload:
    'The OFF choice remains aligned across the interface, browser storage, and backend after reload.',
};

const relevantEventNames = new Set<string>(RELEVANT_EVENT_NAMES);

type OffViolationCode = InvestigationDossierV1['violationCodes'][number];

function isOffViolationCode(value: string): value is OffViolationCode {
  return (
    value === 'PP_IDENTIFIABLE_EVENT_LEAK' ||
    value === 'PP_CONTEXTUAL_FEED_MISSING' ||
    value === 'PP_PREFERENCE_NOT_PERSISTED'
  );
}

function requireCanonicalOffClauses(
  clauses: PromiseClauseResult[],
): PromiseClauseResult[] {
  if (
    clauses.length !== OFF_CLAUSE_IDS.length ||
    clauses.some((clause, index) => clause.id !== OFF_CLAUSE_IDS[index])
  ) {
    throw new Error('Deterministic evaluation did not return canonical OFF clauses.');
  }
  return clauses;
}

function sanitizeEventOrdering(evidence: PromiseEvidence): RelevantEventName[] {
  return evidence.timestamps.clientTimeline.map((entry) => {
    if (!relevantEventNames.has(entry.event)) {
      throw new Error('Evidence contains an event name outside the dossier allowlist.');
    }
    return entry.event as RelevantEventName;
  });
}

function evidenceReferences(
  clauses: PromiseClauseResult[],
  violationCodes: string[],
  evidence: PromiseEvidence,
  eventOrdering: RelevantEventName[],
  activity: InvestigationDossierV1['activity'],
): EvidenceReferenceV1[] {
  const references: EvidenceReferenceV1[] = clauses.map((clause) => ({
    id: `clause.${clause.id}`,
    description: `${CLAUSE_DESCRIPTIONS[clause.id as OffClauseId]} Expected: ${clause.expected}. Observed: ${clause.observed}. Met: ${String(clause.passed)}.`,
  }));

  references.push(
    ...violationCodes.map((code) => ({
      id: `violation.${code}`,
      description: `The deterministic evaluator emitted stable violation code ${code}.`,
    })),
    {
      id: 'state.ui',
      description: `Interface preference=${evidence.ui.preference}; toggle checked=${String(evidence.ui.toggleChecked)}.`,
    },
    {
      id: 'state.browser_storage',
      description: `Browser-storage preference=${String(evidence.storage.preference)}.`,
    },
    {
      id: 'state.backend_preference',
      description: `Backend preference=${evidence.backend.preference}.`,
    },
    {
      id: 'activity.requests',
      description: `Activity requests=${activity.requestCount}; identifiable requests=${activity.identifiableRequestCount}.`,
    },
    {
      id: 'activity.receipts',
      description: `Recommendation-service activity receipts=${activity.receiptCount}; identifiable receipts=${activity.identifiableReceiptCount}.`,
    },
    {
      id: 'recommendation.feed',
      description: `Recommendation mode=${evidence.recommendation.source}; item count=${evidence.recommendation.itemIds.length}; feed functional=${String(evidence.ui.feedFunctional)}.`,
    },
    {
      id: 'events.ordering',
      description: `Ordered event names: ${eventOrdering.join(', ')}.`,
    },
  );

  return references;
}

export function buildInvestigationDossierV1(
  input: unknown,
): InvestigationDossierV1 {
  const evidence = promiseEvidenceSchema.parse(input) as PromiseEvidence;
  if (evidence.scenario !== 'off') {
    throw new Error('An investigation dossier requires an OFF observation.');
  }

  const evaluation = evaluatePromise(evidence);
  if (evaluation.violations.length === 0) {
    throw new Error('An investigation dossier requires a deterministic violation.');
  }

  const clauses = requireCanonicalOffClauses(evaluation.clauses);
  const eventOrdering = sanitizeEventOrdering(evidence);
  const activity: InvestigationDossierV1['activity'] = {
    requestCount: evidence.request.activityPayloads.length,
    identifiableRequestCount: evidence.request.activityPayloads.filter(
      (payload) => payload.userId.length > 0,
    ).length,
    receiptCount: evidence.backend.activityReceipts.length,
    identifiableReceiptCount: evidence.backend.activityReceipts.filter(
      (receipt) =>
        receipt.service === 'recommendation' && receipt.payload.userId.length > 0,
    ).length,
  };
  const evaluatedViolationCodes = evaluation.violations.map(
    (violation) => violation.code,
  );
  if (!evaluatedViolationCodes.every(isOffViolationCode)) {
    throw new Error('OFF evidence produced a violation outside the OFF contract.');
  }
  const violationCodes: OffViolationCode[] = evaluatedViolationCodes;

  const dossier: InvestigationDossierV1 = {
    version: DOSSIER_VERSION,
    promiseStatement: CANONICAL_PROMISE_STATEMENT,
    contractClauses: clauses.map((clause) => ({
      id: clause.id as OffClauseId,
      description: CLAUSE_DESCRIPTIONS[clause.id as OffClauseId],
      expected: clause.expected,
      observed: clause.observed,
      met: clause.passed,
    })),
    violationCodes,
    uiState: {
      preference: evidence.ui.preference,
      toggleChecked: evidence.ui.toggleChecked,
    },
    browserStorageState: {
      preference: evidence.storage.preference,
    },
    backendPreferenceState: {
      preference: evidence.backend.preference,
    },
    activity,
    recommendation: {
      mode: evidence.recommendation.source,
      itemCount: evidence.recommendation.itemIds.length,
      feedFunctional: evidence.ui.feedFunctional,
    },
    eventOrdering,
    evidenceReferences: evidenceReferences(
      clauses,
      violationCodes,
      evidence,
      eventOrdering,
      activity,
    ),
    availableReplays: DIAGNOSTIC_REPLAY_IDS.map((id) => ({
      id,
      description:
        id === DIAGNOSTIC_REPLAYS.inspectStartupOrder.id
          ? DIAGNOSTIC_REPLAYS.inspectStartupOrder.description
          : DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.description,
    })),
  };

  return deepFreeze(
    investigationDossierV1Schema.parse(dossier) as InvestigationDossierV1,
  );
}

export const buildInvestigationDossier = buildInvestigationDossierV1;

function startupReplayReferences(
  report: StartupOrderReplayReportV1,
): EvidenceReferenceV1[] {
  return [
    {
      id: 'replay.startup.event_order',
      description: `Collector index=${report.collectorIndex}; hydration index=${report.hydrationIndex}; collector before hydration=${String(report.collectorBeforeHydration)}.`,
    },
    {
      id: 'replay.startup.activity_counts',
      description: `Activity requests=${report.activityRequestCount}; activity receipts=${report.activityReceiptCount}.`,
    },
    {
      id: 'replay.startup.network_order',
      description: `Network event names=${report.networkEvents.join(', ')}; activity before preference read=${String(report.activityBeforePreferenceRead)}.`,
    },
  ];
}

function preferenceReplayReferences(
  report: PreferenceRoundtripReplayReportV1,
): EvidenceReferenceV1[] {
  return [
    {
      id: 'replay.preference.write_readback',
      description: `Requested=${report.requested}; acknowledged=${report.acknowledged}; authoritative readback=${report.authoritativeReadback}.`,
    },
    {
      id: 'replay.preference.receipt',
      description: `Receipt recorded=${String(report.receiptRecorded)}; identity correlated=${String(report.identityCorrelated)}.`,
    },
    {
      id: 'replay.preference.consistency',
      description: `Write and authoritative readback consistent=${String(report.roundtripConsistent)}.`,
    },
  ];
}

export function normalizeReplayOutputV1(
  replayId: (typeof DIAGNOSTIC_REPLAY_IDS)[number],
  reportInput: unknown,
): NormalizedReplayOutputV1 {
  if (replayId === 'inspect_startup_order') {
    const report = startupOrderReplayReportV1Schema.parse(reportInput);
    return deepFreeze(
      normalizedReplayOutputV1Schema.parse({
        replayId,
        report,
        evidenceReferences: startupReplayReferences(report),
      }) as NormalizedReplayOutputV1,
    );
  }

  const report = preferenceRoundtripReplayReportV1Schema.parse(reportInput);
  return deepFreeze(
    normalizedReplayOutputV1Schema.parse({
      replayId,
      report,
      evidenceReferences: preferenceReplayReferences(report),
    }) as NormalizedReplayOutputV1,
  );
}
