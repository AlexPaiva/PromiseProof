export type PersonalizationPreference = "on" | "off";

export type DemoMode = "initialization-race" | "propagation-failure";

export type PromiseScenario = PersonalizationPreference;

export type RecommendationSource = "contextual" | "behavioral";

export interface ActivityPayload {
  runId: string;
  userId: string;
  eventType: "page_view";
  itemId: string;
  clientSequence: number;
  occurredAt: string;
}

export interface ActivityReceipt {
  kind: "activity";
  service: "recommendation";
  receiptId: string;
  sequence: number;
  receivedAt: string;
  payload: ActivityPayload;
}

export interface RecommendationItem {
  id: string;
  title: string;
  description: string;
  eyebrow: string;
}

export interface RecommendationReceipt {
  kind: "recommendation";
  receiptId: string;
  sequence: number;
  receivedAt: string;
  source: RecommendationSource;
  userId?: string;
  items: RecommendationItem[];
}

export interface PreferenceReceipt {
  kind: "preference";
  receiptId: string;
  sequence: number;
  receivedAt: string;
  userId: string;
  preference: PersonalizationPreference;
}

export interface PreferenceUpdatePayload {
  runId: string;
  preference: PersonalizationPreference;
}

export interface PreferenceUpdateRequest {
  targetUserId: string;
  payload: PreferenceUpdatePayload;
}

export interface PreferenceUpdateResponse {
  userId: string;
  preference: PersonalizationPreference;
  updatedAt: string;
  receipt: PreferenceReceipt;
}

export interface RunEvidenceLedger {
  runId: string;
  activityReceipts: ActivityReceipt[];
  recommendationReceipts: RecommendationReceipt[];
  preferenceReceipts: PreferenceReceipt[];
}

export interface ClientTimelineEntry {
  sequence: number;
  event: string;
  timestamp: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface PromiseEvidence {
  scenario: PromiseScenario;
  runId: string;
  userId: string;
  ui: {
    preference: PersonalizationPreference;
    toggleChecked: boolean;
    feedFunctional: boolean;
  };
  storage: {
    preference: PersonalizationPreference | null;
  };
  request: {
    activityPayloads: ActivityPayload[];
    preferenceUpdates: PreferenceUpdateRequest[];
  };
  response: {
    preferenceUpdates: PreferenceUpdateResponse[];
  };
  backend: {
    preference: PersonalizationPreference;
    activityReceipts: ActivityReceipt[];
    recommendationReceipts: RecommendationReceipt[];
    preferenceReceipts: PreferenceReceipt[];
  };
  recommendation: {
    source: RecommendationSource;
    itemIds: string[];
  };
  timestamps: {
    clientTimeline: ClientTimelineEntry[];
    activityReceivedAt: string[];
    preferenceReceivedAt: string[];
    recommendationReceivedAt: string[];
  };
  journey: {
    reloadObserved: boolean;
  };
}

export type PromiseClauseId =
  | "no_identifiable_activity"
  | "contextual_feed_functional"
  | "preference_survives_reload"
  | "expected_activity_received"
  | "behavioral_feed_functional";

export type PromiseViolationCode =
  | "PP_IDENTIFIABLE_EVENT_LEAK"
  | "PP_CONTEXTUAL_FEED_MISSING"
  | "PP_PREFERENCE_NOT_PERSISTED"
  | "PP_EXPECTED_ACTIVITY_MISSING"
  | "PP_BEHAVIORAL_FEED_MISSING";

export interface PromiseClauseResult {
  id: PromiseClauseId;
  passed: boolean;
  expected: string;
  observed: string;
}

export interface PromiseViolation {
  code: PromiseViolationCode;
  clause: PromiseClauseId;
  message: string;
}

export interface PromiseEvaluation {
  verdict: "pass" | "fail";
  clauses: PromiseClauseResult[];
  violations: PromiseViolation[];
}
