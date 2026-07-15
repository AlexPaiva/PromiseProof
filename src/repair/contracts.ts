export const LIVE_STABILITY_RECEIPT_SCHEMA_VERSION =
  'promiseproof.live-stability-receipt.v1' as const;

export const REPAIR_CANDIDATE_SCHEMA_VERSION =
  'promiseproof.race-repair-candidate.v1' as const;

export const CANONICAL_PROMISE_AUTHORITY =
  'deterministic_typescript_and_playwright_only' as const;

export const CANONICAL_ARTIFACT_INTEGRITY_MEANING =
  'canonical_sha256_consistency_not_provider_origin_attestation' as const;

export const CANONICAL_SOURCE_SNAPSHOT_MEANING =
  'pre_run_and_post_run_canonical_file_manifest_match' as const;

export const RETAINED_RESPONSE_ID_SCOPE =
  'retained_six_run_cohort' as const;

export const RACE_EVIDENCE_SIGNATURE =
  'identifiable_activity_leak' as const;
export const RACE_VIOLATION_CODE = 'PP_IDENTIFIABLE_EVENT_LEAK' as const;
export const RACE_REPLAY_ID = 'inspect_startup_order' as const;
export const RACE_FAILED_CLAUSE_ID = 'no_identifiable_activity' as const;

export const PROPAGATION_EVIDENCE_SIGNATURE =
  'preference_state_mismatch' as const;
export const PROPAGATION_VIOLATION_CODE =
  'PP_PREFERENCE_NOT_PERSISTED' as const;
export const PROPAGATION_REPLAY_ID =
  'inspect_preference_roundtrip' as const;

export const REQUESTED_REPAIR_MODEL = 'gpt-5.6' as const;
export const ALLOWED_RETURNED_REPAIR_MODELS = [
  'gpt-5.6',
  'gpt-5.6-sol',
] as const;

export const REPAIR_HYPOTHESIS_IDS = ['h1', 'h2', 'h3', 'h4'] as const;

export type RepairHypothesisIdV1 =
  (typeof REPAIR_HYPOTHESIS_IDS)[number];
export type AllowedReturnedRepairModelV1 =
  (typeof ALLOWED_RETURNED_REPAIR_MODELS)[number];

export interface RaceRepairFactsV1 {
  readonly failedClauseId: typeof RACE_FAILED_CLAUSE_ID;
  readonly identifiableActivityRequests: 1;
  readonly identifiableActivityReceipts: 1;
  readonly collectorBeforeHydration: true;
  readonly activityBeforePreferenceRead: true;
}

export interface RaceRepairCandidateV1 {
  readonly schemaVersion: typeof REPAIR_CANDIDATE_SCHEMA_VERSION;
  readonly candidateKind: 'startup_order_repair';
  readonly promiseAuthority: typeof CANONICAL_PROMISE_AUTHORITY;
  readonly source: {
    readonly receiptSchemaVersion: typeof LIVE_STABILITY_RECEIPT_SCHEMA_VERSION;
    readonly canonicalReceiptSha256: string;
    readonly sourceSnapshotSha256: string;
    readonly sourceSnapshotMeaning: typeof CANONICAL_SOURCE_SNAPSHOT_MEANING;
    readonly artifactIntegrityMeaning: typeof CANONICAL_ARTIFACT_INTEGRITY_MEANING;
  };
  readonly evidence: {
    readonly evidenceSignature: typeof RACE_EVIDENCE_SIGNATURE;
    readonly violationCode: typeof RACE_VIOLATION_CODE;
    readonly selectedReplay: typeof RACE_REPLAY_ID;
    readonly dossierSha256: string;
    readonly investigationIdCohortSha256: string;
    readonly responseIdCohortSha256: string;
    readonly canonicalArtifactSha256s: readonly string[];
    readonly leadingHypothesisIds: readonly RepairHypothesisIdV1[];
    readonly returnedModels: readonly AllowedReturnedRepairModelV1[];
    readonly runCount: 3;
    readonly responseCount: 6;
    readonly facts: RaceRepairFactsV1;
  };
  readonly deterministicChecks: {
    readonly stableDossierAcrossRuns: true;
    readonly uniqueInvestigationIds: true;
    readonly uniqueResponseIds: true;
    readonly completedAllowlistedResponsesOnly: true;
    readonly modelVerdictUsed: false;
  };
}
