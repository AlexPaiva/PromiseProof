import { sha256CanonicalJson } from '../investigation/canonical-json.js';
import { deepFreeze } from '../investigation/immutable.js';
import {
  CANONICAL_ARTIFACT_INTEGRITY_MEANING,
  CANONICAL_PROMISE_AUTHORITY,
  CANONICAL_SOURCE_SNAPSHOT_MEANING,
  LIVE_STABILITY_RECEIPT_SCHEMA_VERSION,
  RACE_EVIDENCE_SIGNATURE,
  RACE_REPLAY_ID,
  RACE_VIOLATION_CODE,
  REPAIR_CANDIDATE_SCHEMA_VERSION,
  type AllowedReturnedRepairModelV1,
  type RaceRepairCandidateV1,
  type RepairHypothesisIdV1,
} from './contracts.js';
import {
  liveStabilityReceiptV1Schema,
  raceRepairCandidateV1Schema,
} from './schemas.js';

export const REPAIR_INELIGIBLE_CODE = 'PP_REPAIR_INELIGIBLE' as const;

const FORBIDDEN_AUTHORITY_MARKERS = [
  'initialization-race',
  'propagation-failure',
  'DEMO_MODE',
  'hypothesisTitle',
] as const;

export class RepairEligibilityError extends Error {
  readonly code = REPAIR_INELIGIBLE_CODE;

  constructor(reason: string) {
    super(`${REPAIR_INELIGIBLE_CODE}: ${reason}`);
    this.name = 'RepairEligibilityError';
  }
}

function ineligible(reason: string): never {
  throw new RepairEligibilityError(reason);
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function deriveRaceRepairCandidateV1(
  input: unknown,
): RaceRepairCandidateV1 {
  const parsed = liveStabilityReceiptV1Schema.safeParse(input);
  if (!parsed.success) {
    ineligible('The live stability receipt failed strict schema validation.');
  }

  const receipt = parsed.data;
  const serializedReceipt = JSON.stringify(receipt);
  if (
    FORBIDDEN_AUTHORITY_MARKERS.some((marker) =>
      serializedReceipt.includes(marker),
    )
  ) {
    ineligible('The receipt contains fixture, demo-mode, or title authority.');
  }

  const race = receipt.groups[0];
  const responses = race.runs.flatMap((run) => run.responses);
  const investigationIds = race.runs.map((run) => run.investigationId);
  const responseIds = responses.map((response) => response.responseId);
  const dossierHashes = race.runs.map((run) => run.dossierSha256);

  if (
    receipt.productVerdictAuthority !== CANONICAL_PROMISE_AUTHORITY ||
    receipt.requestedModel !== 'gpt-5.6'
  ) {
    ineligible('The receipt does not retain the canonical authority and model.');
  }
  if (
    race.evidenceSignature !== RACE_EVIDENCE_SIGNATURE ||
    race.expectedViolationCode !== RACE_VIOLATION_CODE ||
    race.selectedReplay !== RACE_REPLAY_ID
  ) {
    ineligible('The retained race evidence does not select the startup replay.');
  }
  if (race.runs.length !== 3 || responses.length !== 6) {
    ineligible('The race evidence must contain exactly three runs and six responses.');
  }
  if (
    race.verifiedFactualSignature.identifiableActivityRequests !== 1 ||
    race.verifiedFactualSignature.identifiableActivityReceipts !== 1 ||
    !race.verifiedFactualSignature.collectorBeforeHydration ||
    !race.verifiedFactualSignature.activityBeforePreferenceRead
  ) {
    ineligible('The startup-order factual signature is incomplete.');
  }
  if (
    dossierHashes.some((hash) => hash !== race.dossierSha256) ||
    new Set(dossierHashes).size !== 1
  ) {
    ineligible('The race dossier hash is not stable across all runs.');
  }
  if (!hasUniqueValues(investigationIds)) {
    ineligible('The race investigation IDs are not unique.');
  }
  if (!hasUniqueValues(responseIds)) {
    ineligible('The race response IDs are not unique.');
  }
  if (
    responses.some(
      (response) =>
        response.status !== 'completed' ||
        (response.model !== 'gpt-5.6' && response.model !== 'gpt-5.6-sol'),
    )
  ) {
    ineligible('Every race response must be completed by an allowlisted model.');
  }
  if (race.runs.some((run) => run.leadingHypothesisId.length === 0)) {
    ineligible('Every race run must retain its leading hypothesis ID.');
  }

  const candidate: RaceRepairCandidateV1 = {
    schemaVersion: REPAIR_CANDIDATE_SCHEMA_VERSION,
    candidateKind: 'startup_order_repair',
    promiseAuthority: CANONICAL_PROMISE_AUTHORITY,
    source: {
      receiptSchemaVersion: LIVE_STABILITY_RECEIPT_SCHEMA_VERSION,
      canonicalReceiptSha256: sha256CanonicalJson(receipt),
      sourceSnapshotSha256: receipt.sourceSnapshotSha256,
      sourceSnapshotMeaning: CANONICAL_SOURCE_SNAPSHOT_MEANING,
      artifactIntegrityMeaning: CANONICAL_ARTIFACT_INTEGRITY_MEANING,
    },
    evidence: {
      evidenceSignature: RACE_EVIDENCE_SIGNATURE,
      violationCode: RACE_VIOLATION_CODE,
      selectedReplay: RACE_REPLAY_ID,
      dossierSha256: race.dossierSha256,
      investigationIdCohortSha256: sha256CanonicalJson(investigationIds),
      responseIdCohortSha256: sha256CanonicalJson(responseIds),
      canonicalArtifactSha256s: race.runs.map(
        (run) => run.canonicalArtifactSha256,
      ),
      leadingHypothesisIds: race.runs.map(
        (run) => run.leadingHypothesisId,
      ) as RepairHypothesisIdV1[],
      returnedModels: responses.map(
        (response) => response.model,
      ) as AllowedReturnedRepairModelV1[],
      runCount: 3,
      responseCount: 6,
      facts: {
        failedClauseId: race.verifiedFactualSignature.failedClauseId,
        identifiableActivityRequests: 1,
        identifiableActivityReceipts: 1,
        collectorBeforeHydration: true,
        activityBeforePreferenceRead: true,
      },
    },
    deterministicChecks: {
      stableDossierAcrossRuns: true,
      uniqueInvestigationIds: true,
      uniqueResponseIds: true,
      completedAllowlistedResponsesOnly: true,
      modelVerdictUsed: false,
    },
  };

  const validatedCandidate = raceRepairCandidateV1Schema.safeParse(candidate);
  if (!validatedCandidate.success) {
    ineligible('The derived repair candidate failed its output contract.');
  }
  return deepFreeze(validatedCandidate.data);
}
