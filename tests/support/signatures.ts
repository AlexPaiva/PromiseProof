import type { ScenarioResult } from './scenario.js';

const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function validTimestamps(result: ScenarioResult): boolean {
  const client = result.evidence.timestamps.clientTimeline;
  const all = [
    ...client.map((entry) => entry.timestamp),
    ...result.evidence.timestamps.activityReceivedAt,
    ...result.evidence.timestamps.preferenceReceivedAt,
    ...result.evidence.timestamps.recommendationReceivedAt,
  ];

  return (
    all.length > 0 &&
    all.every(
      (timestamp) =>
        CANONICAL_TIMESTAMP.test(timestamp) &&
        Number.isFinite(Date.parse(timestamp)),
    ) &&
    client.every(
      (entry, index) =>
        index === 0 ||
        Date.parse(client[index - 1]?.timestamp ?? '') <=
          Date.parse(entry.timestamp),
    )
  );
}

function validClientSequence(result: ScenarioResult): boolean {
  return result.evidence.timestamps.clientTimeline.every(
    (entry, index) => entry.sequence === index + 1,
  );
}

function validLedgerSequence(result: ScenarioResult): boolean {
  const receipts = [
    ...result.ledger.activityReceipts,
    ...result.ledger.preferenceReceipts,
    ...result.ledger.recommendationReceipts,
  ].sort((left, right) => left.sequence - right.sequence);

  return receipts.every(
    (receipt, index) =>
      receipt.sequence === index + 1 &&
      receipt.receiptId === `${result.evidence.runId}:${index + 1}`,
  );
}

export function structuralSignature(
  result: ScenarioResult,
): Record<string, unknown> {
  const hydration = result.evidence.timestamps.clientTimeline.find(
    (entry) => entry.event === 'preference_hydration_completed',
  );
  const collector = result.evidence.timestamps.clientTimeline.find(
    (entry) => entry.event === 'collector_started',
  );
  const recommendationReceipt = result.evidence.backend.recommendationReceipts.at(-1);
  const serializedEvidence = JSON.stringify(result.evidence);

  return {
    scenario: result.evidence.scenario,
    state: {
      ui: result.evidence.ui.preference,
      toggleChecked: result.evidence.ui.toggleChecked,
      storage: result.evidence.storage.preference,
      backend: result.evidence.backend.preference,
      displayedBackend: result.displayedBackendPreference,
      crossBoundaryMatch:
        result.evidence.ui.preference === result.evidence.storage.preference &&
        result.evidence.ui.preference === result.evidence.backend.preference,
      reloadObserved: result.evidence.journey.reloadObserved,
    },
    activity: {
      requestCount: result.evidence.request.activityPayloads.length,
      responseCount: result.networkActivityResponses.length,
      backendReceiptCount: result.evidence.backend.activityReceipts.length,
      acceptedResponses: result.networkActivityResponses.map(
        (response) => response.accepted,
      ),
      requestUsersMatch: result.evidence.request.activityPayloads.map(
        (payload) => payload.userId === result.evidence.userId,
      ),
      payloadReceiptCorrelations: result.evidence.request.activityPayloads.map(
        (payload) =>
          result.evidence.backend.activityReceipts.some(
            (receipt) =>
              JSON.stringify(receipt.payload) === JSON.stringify(payload),
          ),
      ),
      receiptServices: result.evidence.backend.activityReceipts.map(
        (receipt) => receipt.service,
      ),
    },
    preference: {
      requestCount: result.evidence.request.preferenceUpdates.length,
      responseCount: result.evidence.response.preferenceUpdates.length,
      backendReceiptCount: result.evidence.backend.preferenceReceipts.length,
      requested: result.evidence.request.preferenceUpdates.map(
        (update) => update.payload.preference,
      ),
      requestTargetsMatch: result.evidence.request.preferenceUpdates.map(
        (update) => update.targetUserId === result.evidence.userId,
      ),
      acknowledged: result.evidence.response.preferenceUpdates.map(
        (response) => response.preference,
      ),
      responseUsersMatch: result.evidence.response.preferenceUpdates.map(
        (response) => response.userId === result.evidence.userId,
      ),
      receiptPreferences: result.evidence.backend.preferenceReceipts.map(
        (receipt) => receipt.preference,
      ),
      receiptUsersMatch: result.evidence.backend.preferenceReceipts.map(
        (receipt) => receipt.userId === result.evidence.userId,
      ),
      responseReceiptsMatchLedger: result.evidence.response.preferenceUpdates.every(
        (response) =>
          result.evidence.backend.preferenceReceipts.some(
            (receipt) =>
              JSON.stringify(receipt) === JSON.stringify(response.receipt),
          ),
      ),
      authoritativeReadback: result.backendPreferenceState.preference,
      readbackUserMatches:
        result.backendPreferenceState.userId === result.evidence.userId,
    },
    recommendation: {
      source: result.evidence.recommendation.source,
      renderedItemCount: result.evidence.recommendation.itemIds.length,
      backendReceiptCount:
        result.evidence.backend.recommendationReceipts.length,
      receiptSource: recommendationReceipt?.source ?? null,
      receiptUserMatches:
        recommendationReceipt?.userId === undefined
          ? null
          : recommendationReceipt.userId === result.evidence.userId,
      renderedItemsMatchReceipt:
        JSON.stringify(
          recommendationReceipt?.items.map((item) => item.id) ?? [],
        ) === JSON.stringify(result.evidence.recommendation.itemIds),
      allCardsVisibleAndComplete: result.renderedRecommendations.every(
        (item) =>
          item.visible &&
          item.titleVisible &&
          item.descriptionVisible &&
          item.title.length > 0 &&
          item.description.length > 0,
      ),
    },
    causalOrder: {
      timeline: result.evidence.timestamps.clientTimeline.map(
        (entry) => entry.event,
      ),
      hydratedPreference: hydration?.detail?.preference ?? null,
      hydratedBackendPreference:
        hydration?.detail?.backendPreference ?? null,
      collectorPreference: collector?.detail?.inMemoryPreference ?? null,
      networkRequestOrder: result.networkRequestOrder.map(
        (observation) => `${observation.phase}:${observation.event}`,
      ),
    },
    integrity: {
      timestampsCanonicalAndOrdered: validTimestamps(result),
      clientSequenceContiguous: validClientSequence(result),
      ledgerSequenceContiguous: validLedgerSequence(result),
      evidenceContainsFixtureName:
        serializedEvidence.includes('initialization-race') ||
        serializedEvidence.includes('propagation-failure'),
    },
    evaluation: {
      verdict: result.evaluation.verdict,
      violations: result.evaluation.violations.map((item) => item.code),
      clauses: result.evaluation.clauses.map(
        (item) => `${item.id}:${String(item.passed)}`,
      ),
    },
    browserErrorCount: result.browserErrors.length,
  };
}

const noPreferenceTraffic = {
  requestCount: 0,
  responseCount: 0,
  backendReceiptCount: 0,
  requested: [],
  requestTargetsMatch: [],
  acknowledged: [],
  responseUsersMatch: [],
  receiptPreferences: [],
  receiptUsersMatch: [],
  responseReceiptsMatchLedger: true,
  readbackUserMatches: true,
};

const healthyIntegrity = {
  timestampsCanonicalAndOrdered: true,
  clientSequenceContiguous: true,
  ledgerSequenceContiguous: true,
  evidenceContainsFixtureName: false,
};

export const expectedInitializationOffSignature = {
  scenario: 'off',
  state: {
    ui: 'off',
    toggleChecked: false,
    storage: 'off',
    backend: 'off',
    displayedBackend: 'off',
    crossBoundaryMatch: true,
    reloadObserved: true,
  },
  activity: {
    requestCount: 1,
    responseCount: 1,
    backendReceiptCount: 1,
    acceptedResponses: [true],
    requestUsersMatch: [true],
    payloadReceiptCorrelations: [true],
    receiptServices: ['recommendation'],
  },
  preference: {
    requestCount: 1,
    responseCount: 1,
    backendReceiptCount: 1,
    requested: ['off'],
    requestTargetsMatch: [true],
    acknowledged: ['off'],
    responseUsersMatch: [true],
    receiptPreferences: ['off'],
    receiptUsersMatch: [true],
    responseReceiptsMatchLedger: true,
    authoritativeReadback: 'off',
    readbackUserMatches: true,
  },
  recommendation: {
    source: 'contextual',
    renderedItemCount: 3,
    backendReceiptCount: 2,
    receiptSource: 'contextual',
    receiptUserMatches: null,
    renderedItemsMatchReceipt: true,
    allCardsVisibleAndComplete: true,
  },
  causalOrder: {
    timeline: [
      'collector_started',
      'activity_dispatched',
      'activity_received',
      'preference_hydration_started',
      'preference_hydration_completed',
      'recommendation_rendered',
    ],
    hydratedPreference: 'off',
    hydratedBackendPreference: 'off',
    collectorPreference: 'on',
    networkRequestOrder: [
      'opt_out:preference_write',
      'opt_out:preference_read',
      'reload:activity_post',
      'reload:preference_read',
      'reload:preference_read',
    ],
  },
  integrity: healthyIntegrity,
  evaluation: {
    verdict: 'fail',
    violations: ['PP_IDENTIFIABLE_EVENT_LEAK'],
    clauses: [
      'no_identifiable_activity:false',
      'contextual_feed_functional:true',
      'preference_survives_reload:true',
    ],
  },
  browserErrorCount: 0,
};

export const expectedPropagationOffSignature = {
  scenario: 'off',
  state: {
    ui: 'off',
    toggleChecked: false,
    storage: 'off',
    backend: 'on',
    displayedBackend: 'on',
    crossBoundaryMatch: false,
    reloadObserved: true,
  },
  activity: {
    requestCount: 0,
    responseCount: 0,
    backendReceiptCount: 0,
    acceptedResponses: [],
    requestUsersMatch: [],
    payloadReceiptCorrelations: [],
    receiptServices: [],
  },
  preference: {
    requestCount: 2,
    responseCount: 2,
    backendReceiptCount: 2,
    requested: ['off', 'off'],
    requestTargetsMatch: [true, true],
    acknowledged: ['off', 'off'],
    responseUsersMatch: [true, true],
    receiptPreferences: ['off', 'off'],
    receiptUsersMatch: [true, true],
    responseReceiptsMatchLedger: true,
    authoritativeReadback: 'on',
    readbackUserMatches: true,
  },
  recommendation: {
    source: 'contextual',
    renderedItemCount: 3,
    backendReceiptCount: 2,
    receiptSource: 'contextual',
    receiptUserMatches: null,
    renderedItemsMatchReceipt: true,
    allCardsVisibleAndComplete: true,
  },
  causalOrder: {
    timeline: [
      'preference_hydration_started',
      'preference_sync_dispatched',
      'preference_sync_acknowledged',
      'backend_preference_observed',
      'preference_hydration_completed',
      'collector_started',
      'collector_suppressed',
      'recommendation_rendered',
    ],
    hydratedPreference: 'off',
    hydratedBackendPreference: 'on',
    collectorPreference: 'off',
    networkRequestOrder: [
      'opt_out:preference_write',
      'opt_out:preference_read',
      'reload:preference_read',
      'reload:preference_write',
      'reload:preference_read',
      'reload:preference_read',
    ],
  },
  integrity: healthyIntegrity,
  evaluation: {
    verdict: 'fail',
    violations: ['PP_PREFERENCE_NOT_PERSISTED'],
    clauses: [
      'no_identifiable_activity:true',
      'contextual_feed_functional:true',
      'preference_survives_reload:false',
    ],
  },
  browserErrorCount: 0,
};

export function expectedOnSignature(
  timeline: string[],
): Record<string, unknown> {
  return {
    scenario: 'on',
    state: {
      ui: 'on',
      toggleChecked: true,
      storage: 'on',
      backend: 'on',
      displayedBackend: 'on',
      crossBoundaryMatch: true,
      reloadObserved: false,
    },
    activity: {
      requestCount: 1,
      responseCount: 1,
      backendReceiptCount: 1,
      acceptedResponses: [true],
      requestUsersMatch: [true],
      payloadReceiptCorrelations: [true],
      receiptServices: ['recommendation'],
    },
    preference: { ...noPreferenceTraffic, authoritativeReadback: 'on' },
    recommendation: {
      source: 'behavioral',
      renderedItemCount: 3,
      backendReceiptCount: 1,
      receiptSource: 'behavioral',
      receiptUserMatches: true,
      renderedItemsMatchReceipt: true,
      allCardsVisibleAndComplete: true,
    },
    causalOrder: {
      timeline,
      hydratedPreference: 'on',
      hydratedBackendPreference: 'on',
      collectorPreference: 'on',
      networkRequestOrder:
        timeline[0] === 'collector_started'
          ? [
              'startup:activity_post',
              'startup:preference_read',
              'startup:preference_read',
            ]
          : [
              'startup:preference_read',
              'startup:activity_post',
              'startup:preference_read',
            ],
    },
    integrity: healthyIntegrity,
    evaluation: {
      verdict: 'pass',
      violations: [],
      clauses: [
        'expected_activity_received:true',
        'behavioral_feed_functional:true',
      ],
    },
    browserErrorCount: 0,
  };
}
