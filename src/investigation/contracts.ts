import { DIAGNOSTIC_REPLAYS } from '../shared/diagnostics.js';
import type { PromiseViolationCode } from '../shared/types.js';

export const MODEL_ID = 'gpt-5.6' as const;
export const TOOL_NAME = 'run_diagnostic_replay' as const;
export const PROMPT_VERSION = 'promiseproof.investigation-prompt.v1' as const;
export const DOSSIER_VERSION = 'promiseproof.investigation-dossier.v1' as const;

export const DIAGNOSTIC_REPLAY_IDS = [
  DIAGNOSTIC_REPLAYS.inspectStartupOrder.id,
  DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.id,
] as const;

export type DiagnosticReplayId = (typeof DIAGNOSTIC_REPLAY_IDS)[number];

export const OFF_CLAUSE_IDS = [
  'no_identifiable_activity',
  'contextual_feed_functional',
  'preference_survives_reload',
] as const;

export type OffClauseId = (typeof OFF_CLAUSE_IDS)[number];

export const RELEVANT_EVENT_NAMES = [
  'collector_started',
  'collector_suppressed',
  'activity_dispatched',
  'activity_received',
  'preference_hydration_started',
  'preference_sync_dispatched',
  'preference_sync_acknowledged',
  'backend_preference_observed',
  'preference_hydration_completed',
  'recommendation_rendered',
] as const;

export type RelevantEventName = (typeof RELEVANT_EVENT_NAMES)[number];

export const HYPOTHESIS_IDS = ['h1', 'h2', 'h3', 'h4'] as const;

export type InvestigationHypothesisIdV1 = (typeof HYPOTHESIS_IDS)[number];

export interface EvidenceReferenceV1 {
  id: string;
  description: string;
}

export interface DossierClauseV1 {
  id: OffClauseId;
  description: string;
  expected: string;
  observed: string;
  met: boolean;
}

export interface InvestigationDossierV1 {
  version: typeof DOSSIER_VERSION;
  promiseStatement: string;
  contractClauses: DossierClauseV1[];
  violationCodes: Array<
    Extract<
      PromiseViolationCode,
      | 'PP_IDENTIFIABLE_EVENT_LEAK'
      | 'PP_CONTEXTUAL_FEED_MISSING'
      | 'PP_PREFERENCE_NOT_PERSISTED'
    >
  >;
  uiState: {
    preference: 'on' | 'off';
    toggleChecked: boolean;
  };
  browserStorageState: {
    preference: 'on' | 'off' | null;
  };
  backendPreferenceState: {
    preference: 'on' | 'off';
  };
  activity: {
    requestCount: number;
    identifiableRequestCount: number;
    receiptCount: number;
    identifiableReceiptCount: number;
  };
  recommendation: {
    mode: 'contextual' | 'behavioral';
    itemCount: number;
    feedFunctional: boolean;
  };
  eventOrdering: RelevantEventName[];
  evidenceReferences: EvidenceReferenceV1[];
  availableReplays: Array<{
    id: DiagnosticReplayId;
    description: string;
  }>;
}

export interface RankedHypothesisV1 {
  id: InvestigationHypothesisIdV1;
  title: string;
  rank: number;
  confidence: number;
  supportingEvidence: string[];
  contradictingEvidence: string[];
}

export interface ReplayToolArgumentsV1 {
  replayId: DiagnosticReplayId;
  hypotheses: RankedHypothesisV1[];
  purpose: string;
  evidenceReferences: string[];
}

export type InvestigationHypothesisStatusV1 =
  | 'supported'
  | 'weakened'
  | 'unresolved';

export const INVESTIGATION_LIMITATION_CODES = [
  'single_replay_scope',
  'synthetic_evidence_scope',
  'diagnostic_not_verdict',
] as const;

export type InvestigationLimitationCodeV1 =
  (typeof INVESTIGATION_LIMITATION_CODES)[number];

export const INVESTIGATION_LIMITATION_TEXT: Record<
  InvestigationLimitationCodeV1,
  string
> = {
  single_replay_scope:
    'The diagnostic assessment is limited to one registered factual replay.',
  synthetic_evidence_scope:
    'The prototype uses only deterministic synthetic application evidence.',
  diagnostic_not_verdict:
    'Diagnostic hypotheses do not determine the product promise verdict.',
};

export interface InvestigationHypothesisV1 {
  hypothesisId: InvestigationHypothesisIdV1;
  relativeConfidence: number;
  supportingEvidenceReferences: string[];
  contradictingEvidenceReferences: string[];
  status: InvestigationHypothesisStatusV1;
}

export interface InvestigationResultV1 {
  hypotheses: InvestigationHypothesisV1[];
  mostLikelyHypothesisId: InvestigationHypothesisIdV1;
  replayPerformed: DiagnosticReplayId;
  conclusionEvidenceReferences: string[];
  limitationCodes: InvestigationLimitationCodeV1[];
}

export interface StartupOrderReplayReportV1 {
  events: RelevantEventName[];
  collectorIndex: number;
  hydrationIndex: number;
  collectorBeforeHydration: boolean;
  activityRequestCount: number;
  activityReceiptCount: number;
  networkEvents: Array<
    'activity_post' | 'preference_read' | 'preference_write'
  >;
  activityBeforePreferenceRead: boolean;
}

export interface PreferenceRoundtripReplayReportV1 {
  requested: 'off';
  acknowledged: 'on' | 'off';
  authoritativeReadback: 'on' | 'off';
  receiptRecorded: boolean;
  identityCorrelated: boolean;
  roundtripConsistent: boolean;
}

export type ReplayReportV1 =
  | {
      replayId: 'inspect_startup_order';
      report: StartupOrderReplayReportV1;
    }
  | {
      replayId: 'inspect_preference_roundtrip';
      report: PreferenceRoundtripReplayReportV1;
    };

export type NormalizedReplayOutputV1 = ReplayReportV1 & {
  evidenceReferences: EvidenceReferenceV1[];
};
