import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { canonicalJson, sha256CanonicalJson } from '../src/investigation/canonical-json.js';
import {
  INVESTIGATION_LIMITATION_CODES,
  MODEL_ID,
  PROMPT_VERSION,
  type DiagnosticReplayId,
  type InvestigationHypothesisIdV1,
} from '../src/investigation/contracts.js';
import { containsAuthoritativeOutcomeLanguage } from '../src/investigation/authority-boundary.js';
import {
  CANONICAL_PROMISE_STATEMENT,
  normalizeReplayOutputV1,
} from '../src/investigation/dossier.js';
import { OPENAI_API_BASE_URL } from '../src/investigation/openai-provider.js';
import {
  investigationDossierV1Schema,
  investigationResultV1Schema,
  normalizedReplayOutputV1Schema,
  replayToolArgumentsV1Schema,
} from '../src/investigation/schemas.js';
import type { ModelTokenUsage } from '../src/investigation/provider.js';
import { DIAGNOSTIC_REPLAYS } from '../src/shared/diagnostics.js';

const ARTIFACT_BASENAME = 'promiseproof-live-investigation.json';
const RECEIPT_SCHEMA_VERSION =
  'promiseproof.live-stability-receipt.v1' as const;
const SOURCE_SNAPSHOT_SCHEMA_VERSION =
  'promiseproof.live-source-snapshot.v1' as const;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_RUNS_PER_SIGNATURE = 3;

const EXPECTED_VALIDATION_SEQUENCE = [
  ['response_metadata', 'PP_INV_RESPONSE_METADATA_ACCEPTED'],
  ['model_identity', 'PP_INV_MODEL_IDENTITY_ACCEPTED'],
  ['response_status', 'PP_INV_RESPONSE_COMPLETED'],
  ['output_items', 'PP_INV_OUTPUT_BOUNDED'],
  ['output_item_status', 'PP_INV_OUTPUT_ITEM_COMPLETED'],
  ['response_content', 'PP_INV_SELECTION_CONTENT_ACCEPTED'],
  ['tool_count', 'PP_INV_SINGLE_TOOL_CALL'],
  ['tool_name', 'PP_INV_TOOL_ALLOWLISTED'],
  ['tool_call_id', 'PP_INV_TOOL_CALL_ID_ACCEPTED'],
  ['arguments_json', 'PP_INV_ARGUMENTS_JSON'],
  ['arguments_schema', 'PP_INV_ARGUMENTS_SCHEMA_ACCEPTED'],
  ['hypothesis_ranking', 'PP_INV_HYPOTHESIS_RANKING_ACCEPTED'],
  ['evidence_references', 'PP_INV_EVIDENCE_REFERENCES_ACCEPTED'],
  ['verdict_boundary', 'PP_INV_VERDICT_BOUNDARY_ACCEPTED'],
  ['response_metadata', 'PP_INV_FINAL_RESPONSE_METADATA_ACCEPTED'],
  ['model_identity', 'PP_INV_FINAL_MODEL_IDENTITY_ACCEPTED'],
  ['response_status', 'PP_INV_FINAL_RESPONSE_COMPLETED'],
  ['final_output_kinds', 'PP_INV_FINAL_OUTPUT_BOUNDED'],
  ['final_message_status', 'PP_INV_FINAL_OUTPUT_ITEM_COMPLETED'],
  ['final_message_content', 'PP_INV_FINAL_MESSAGE_CONTENT_ACCEPTED'],
  ['result_json', 'PP_INV_RESULT_JSON'],
  ['result_schema', 'PP_INV_RESULT_SCHEMA_ACCEPTED'],
  ['replay_identity', 'PP_INV_REPLAY_IDENTITY_ACCEPTED'],
  ['hypothesis_continuity', 'PP_INV_HYPOTHESIS_CONTINUITY_ACCEPTED'],
  ['leading_hypothesis', 'PP_INV_LEADING_HYPOTHESIS_ACCEPTED'],
  ['evidence_references', 'PP_INV_FINAL_EVIDENCE_REFERENCES_ACCEPTED'],
  ['material_update', 'PP_INV_MATERIAL_UPDATE_ACCEPTED'],
  ['verdict_boundary', 'PP_INV_FINAL_VERDICT_BOUNDARY_ACCEPTED'],
] as const;

const FORBIDDEN_BOUNDARY_PATTERNS = [
  /initialization-race/i,
  /propagation-failure/i,
  /\bDEMO_MODE\b/i,
  /\bOPENAI_API_KEY\b/i,
  /\bprocess\.env\b/i,
  /\bAuthorization\s*:\s*Bearer\b/i,
  /\bBearer\s+/i,
  /(?:^|[\s"'])src[\\/][a-z0-9_.-]/im,
  /(?:^|[\s"'])tests[\\/][a-z0-9_.-]/im,
  /\.(?:png|webm|zip)(?:\b|$)/i,
] as const;

export const DEFAULT_STABILITY_PATHS = {
  race: 'test-results/investigation-live-stability-race',
  propagation: 'test-results/investigation-live-stability-propagation',
  sourceSnapshot: 'test-results/investigation-live-source-snapshot.json',
  receipt: 'artifacts/milestone-03-live-stability.json',
} as const;

const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((usage, context) => {
    if (
      usage.cachedInputTokens > usage.inputTokens ||
      usage.reasoningTokens > usage.outputTokens ||
      usage.totalTokens !== usage.inputTokens + usage.outputTokens
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Token usage fields are internally inconsistent.',
      });
    }
  });

const outputItemSchema = z
  .object({
    type: z.string().min(1).max(64),
    status: z.string().min(1).max(64).nullable(),
    contentTypes: z.array(z.string().min(1).max(64)).max(8),
  })
  .strict();

const recordedResponseSchema = z
  .object({
    phase: z.enum(['replay_selection', 'hypothesis_update']),
    responseId: z.string().regex(SAFE_IDENTIFIER),
    model: z.enum(['gpt-5.6', 'gpt-5.6-sol']),
    status: z.literal('completed'),
    latencyMs: z.number().finite().nonnegative(),
    usage: tokenUsageSchema,
    outputItems: z.array(outputItemSchema).min(1).max(10),
    refusalPresent: z.literal(false),
    incompleteReason: z.null(),
    errorPresent: z.literal(false),
  })
  .strict();

const validationDecisionSchema = z
  .object({
    stage: z.string().min(1).max(128),
    accepted: z.literal(true),
    code: z.string().regex(/^PP_INV_[A-Z0-9_]{1,120}$/),
    detail: z.string().min(1).max(1_000),
  })
  .strict();

export const completedLiveArtifactSchema = z
  .object({
    schemaVersion: z.literal('promiseproof.investigation-artifact.v1'),
    investigationId: z.string().uuid(),
    promptVersion: z.literal(PROMPT_VERSION),
    status: z.literal('investigation_completed'),
    dossier: investigationDossierV1Schema,
    dossierSha256: z.string().regex(SHA256),
    provider: z
      .object({
        kind: z.literal('openai'),
        requestedModel: z.literal(MODEL_ID),
        responses: z.array(recordedResponseSchema).length(2),
        aggregateUsage: tokenUsageSchema,
      })
      .strict(),
    bounds: z
      .object({
        maxProviderCalls: z.literal(2),
        providerCallsUsed: z.literal(2),
        maxReplayExecutions: z.literal(1),
        replayExecutionsUsed: z.literal(1),
      })
      .strict(),
    toolValidation: z
      .object({
        accepted: z.literal(true),
        decisions: z.array(validationDecisionSchema).min(1).max(100),
      })
      .strict(),
    toolCallId: z.string().regex(SAFE_IDENTIFIER),
    initialOutput: replayToolArgumentsV1Schema,
    replay: normalizedReplayOutputV1Schema,
    finalOutput: investigationResultV1Schema,
    failure: z.null(),
    timing: z
      .object({
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime(),
        replayMs: z.number().finite().nonnegative(),
        totalMs: z.number().finite().nonnegative(),
      })
      .strict(),
  })
  .strict();

type CompletedLiveArtifact = z.infer<typeof completedLiveArtifactSchema>;

const lastRunSchema = z
  .object({
    status: z.literal('passed'),
    failedTests: z.array(z.string()).length(0),
  })
  .strict();

const sourceSnapshotSchema = z
  .object({
    sha256: z.string().regex(SHA256),
    fileCount: z.number().int().positive(),
  })
  .strict();

const capturedSourceSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SOURCE_SNAPSHOT_SCHEMA_VERSION),
    snapshot: sourceSnapshotSchema,
  })
  .strict();

export interface SourceSnapshot {
  sha256: string;
  fileCount: number;
}

export interface LiveStabilityInputs {
  raceArtifacts: unknown[];
  propagationArtifacts: unknown[];
  sourceSnapshot: SourceSnapshot;
  apiKey?: string;
  credentialCandidates?: readonly string[];
}

interface EvidenceExpectation {
  evidenceSignature:
    | 'identifiable_activity_leak'
    | 'preference_state_mismatch';
  violationCode:
    | 'PP_IDENTIFIABLE_EVENT_LEAK'
    | 'PP_PREFERENCE_NOT_PERSISTED';
  replayId: DiagnosticReplayId;
}

const RACE_EXPECTATION: EvidenceExpectation = {
  evidenceSignature: 'identifiable_activity_leak',
  violationCode: 'PP_IDENTIFIABLE_EVENT_LEAK',
  replayId: 'inspect_startup_order',
};

const PROPAGATION_EXPECTATION: EvidenceExpectation = {
  evidenceSignature: 'preference_state_mismatch',
  violationCode: 'PP_PREFERENCE_NOT_PERSISTED',
  replayId: 'inspect_preference_roundtrip',
};

function invalid(message: string): never {
  throw new Error(`PP_LIVE_STABILITY_INVALID: ${message}`);
}

function isStabilityError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.startsWith('PP_LIVE_STABILITY_INVALID:')
  );
}

function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function credentialCandidates(inputs: {
  apiKey?: string;
  credentialCandidates?: readonly string[];
}): string[] {
  return [inputs.apiKey, ...(inputs.credentialCandidates ?? [])].flatMap(
    (candidate) =>
      candidate === undefined || candidate.length === 0 ? [] : [candidate],
  ).filter((candidate, index, candidates) => candidates.indexOf(candidate) === index);
}

function assertEqualUsage(
  actual: ModelTokenUsage,
  expected: ModelTokenUsage,
  context: string,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    invalid(`${context} token aggregate did not match its responses.`);
  }
}

function sumUsage(
  responses: readonly { usage: ModelTokenUsage }[],
): ModelTokenUsage {
  return responses.reduce<ModelTokenUsage>(
    (total, response) => ({
      inputTokens: total.inputTokens + response.usage.inputTokens,
      cachedInputTokens:
        total.cachedInputTokens + response.usage.cachedInputTokens,
      outputTokens: total.outputTokens + response.usage.outputTokens,
      reasoningTokens:
        total.reasoningTokens + response.usage.reasoningTokens,
      totalTokens: total.totalTokens + response.usage.totalTokens,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    },
  );
}

function assertReasoningItemsAreComplete(
  items: CompletedLiveArtifact['provider']['responses'][number]['outputItems'],
): void {
  if (
    items.some(
      (item) =>
        item.type === 'reasoning' &&
        ((item.status !== null && item.status !== 'completed') ||
          item.contentTypes.length !== 0),
    )
  ) {
    invalid('A reasoning output item was incomplete or carried content.');
  }
}

function assertResponseShapes(artifact: CompletedLiveArtifact): void {
  const [selection, conclusion] = artifact.provider.responses;
  if (
    selection?.phase !== 'replay_selection' ||
    conclusion?.phase !== 'hypothesis_update'
  ) {
    invalid('Provider response phases were absent or out of order.');
  }

  for (const response of artifact.provider.responses) {
    if (
      response.usage.inputTokens <= 0 ||
      response.usage.outputTokens <= 0 ||
      response.usage.totalTokens <= 0
    ) {
      invalid('A live response reported zero required token usage.');
    }
    assertReasoningItemsAreComplete(response.outputItems);
  }

  const selectionCalls = selection.outputItems.filter(
    (item) => item.type === 'function_call',
  );
  if (
    selectionCalls.length !== 1 ||
    selection.outputItems.some(
      (item) => item.type !== 'reasoning' && item.type !== 'function_call',
    ) ||
    selectionCalls[0]?.status !== 'completed' ||
    selectionCalls[0].contentTypes.length !== 0
  ) {
    invalid('The replay-selection response shape was not the bounded tool flow.');
  }

  const conclusionMessages = conclusion.outputItems.filter(
    (item) => item.type === 'message',
  );
  if (
    conclusionMessages.length !== 1 ||
    conclusion.outputItems.some(
      (item) => item.type !== 'reasoning' && item.type !== 'message',
    ) ||
    conclusionMessages[0]?.status !== 'completed' ||
    canonicalJson(conclusionMessages[0].contentTypes) !==
      canonicalJson(['output_text'])
  ) {
    invalid('The hypothesis-update response shape was not one completed message.');
  }
}

function assertValidationSequence(artifact: CompletedLiveArtifact): void {
  const retained = artifact.toolValidation.decisions.map((decision) => [
    decision.stage,
    decision.code,
  ]);
  if (canonicalJson(retained) !== canonicalJson(EXPECTED_VALIDATION_SEQUENCE)) {
    invalid('The retained accepted validation sequence was incomplete or reordered.');
  }
}

function assertInitialGrounding(artifact: CompletedLiveArtifact): void {
  const dossierReferences = new Set(
    artifact.dossier.evidenceReferences.map((reference) => reference.id),
  );
  const initialReferences = [
    ...artifact.initialOutput.evidenceReferences,
    ...artifact.initialOutput.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supportingEvidence,
      ...hypothesis.contradictingEvidence,
    ]),
  ];
  if (initialReferences.some((reference) => !dossierReferences.has(reference))) {
    invalid('An initial hypothesis cited evidence outside the dossier.');
  }
  if (
    artifact.initialOutput.hypotheses.some(
      (hypothesis, index, hypotheses) =>
        hypothesis.rank !== index + 1 ||
        (index > 0 &&
          (hypotheses[index - 1]?.confidence ?? -1) < hypothesis.confidence),
    )
  ) {
    invalid('Initial hypothesis rank or descending confidence order changed.');
  }
}

function assertNormalizedReplay(artifact: CompletedLiveArtifact): void {
  const normalized = normalizeReplayOutputV1(
    artifact.replay.replayId,
    artifact.replay.report,
  );
  if (canonicalJson(normalized) !== canonicalJson(artifact.replay)) {
    invalid('The retained replay was not the exact normalized factual projection.');
  }
}

function allFinalReferences(
  finalOutput: CompletedLiveArtifact['finalOutput'],
): string[] {
  return [
    ...finalOutput.conclusionEvidenceReferences,
    ...finalOutput.hypotheses.flatMap((hypothesis) => [
      ...hypothesis.supportingEvidenceReferences,
      ...hypothesis.contradictingEvidenceReferences,
    ]),
  ];
}

function assertHypothesisContinuity(artifact: CompletedLiveArtifact): void {
  const initialIds = artifact.initialOutput.hypotheses.map(
    (hypothesis) => hypothesis.id,
  );
  const finalIds = artifact.finalOutput.hypotheses.map(
    (hypothesis) => hypothesis.hypothesisId,
  );
  if (canonicalJson(initialIds) !== canonicalJson(finalIds)) {
    invalid('Final hypothesis identity or order changed.');
  }

  const replayReferences = new Set(
    artifact.replay.evidenceReferences.map((reference) => reference.id),
  );
  const allowedReferences = new Set([
    ...artifact.dossier.evidenceReferences.map((reference) => reference.id),
    ...replayReferences,
  ]);
  if (
    allFinalReferences(artifact.finalOutput).some(
      (reference) => !allowedReferences.has(reference),
    )
  ) {
    invalid('The final output cited a reference outside the dossier and replay.');
  }

  const leadingIndex = artifact.finalOutput.hypotheses.reduce(
    (bestIndex, hypothesis, index, hypotheses) =>
      hypothesis.relativeConfidence >
      (hypotheses[bestIndex]?.relativeConfidence ?? -1)
        ? index
        : bestIndex,
    0,
  );
  const leading = artifact.finalOutput.hypotheses[leadingIndex];
  if (
    leading === undefined ||
    leading.hypothesisId !== artifact.finalOutput.mostLikelyHypothesisId ||
    leading.status !== 'supported' ||
    !leading.supportingEvidenceReferences.some((reference) =>
      replayReferences.has(reference),
    )
  ) {
    invalid('The leading hypothesis was not the first replay-cited maximum.');
  }

  for (const hypothesis of artifact.finalOutput.hypotheses) {
    if (hypothesis.status === 'unresolved') {
      continue;
    }
    const references =
      hypothesis.status === 'supported'
        ? hypothesis.supportingEvidenceReferences
        : hypothesis.contradictingEvidenceReferences;
    if (!references.some((reference) => replayReferences.has(reference))) {
      invalid('A resolved hypothesis lacked its status-specific replay citation.');
    }
  }
  if (
    !artifact.finalOutput.conclusionEvidenceReferences.some((reference) =>
      replayReferences.has(reference),
    )
  ) {
    invalid('Conclusion evidence did not cite the executed replay.');
  }
  if (
    canonicalJson(artifact.finalOutput.limitationCodes) !==
    canonicalJson(INVESTIGATION_LIMITATION_CODES)
  ) {
    invalid('Final limitations were not the complete canonical ordered codes.');
  }
}

function assertExpectedEvidence(
  artifact: CompletedLiveArtifact,
  expectation: EvidenceExpectation,
): void {
  if (
    artifact.dossier.promiseStatement !== CANONICAL_PROMISE_STATEMENT ||
    canonicalJson(artifact.dossier.availableReplays) !==
      canonicalJson([
        DIAGNOSTIC_REPLAYS.inspectStartupOrder,
        DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip,
      ])
  ) {
    invalid('The dossier promise or registered replay descriptions changed.');
  }
  if (
    canonicalJson(artifact.dossier.violationCodes) !==
    canonicalJson([expectation.violationCode])
  ) {
    invalid('The dossier did not contain the expected singleton violation.');
  }
  if (
    artifact.initialOutput.replayId !== expectation.replayId ||
    artifact.replay.replayId !== expectation.replayId ||
    artifact.finalOutput.replayPerformed !== expectation.replayId
  ) {
    invalid('Selected, executed, and concluded replay identities did not agree.');
  }
  const failedClauses = artifact.dossier.contractClauses
    .filter((clause) => !clause.met)
    .map((clause) => clause.id);

  if (expectation.replayId === 'inspect_startup_order') {
    if (
      canonicalJson(failedClauses) !==
        canonicalJson(['no_identifiable_activity']) ||
      canonicalJson(
        artifact.dossier.contractClauses.map((clause) => clause.met),
      ) !== canonicalJson([false, true, true]) ||
      artifact.dossier.uiState.preference !== 'off' ||
      artifact.dossier.uiState.toggleChecked ||
      artifact.dossier.browserStorageState.preference !== 'off' ||
      artifact.dossier.backendPreferenceState.preference !== 'off' ||
      artifact.dossier.activity.requestCount !== 1 ||
      artifact.dossier.activity.identifiableRequestCount !== 1 ||
      artifact.dossier.activity.receiptCount !== 1 ||
      artifact.dossier.activity.identifiableReceiptCount !== 1 ||
      artifact.dossier.recommendation.mode !== 'contextual' ||
      artifact.dossier.recommendation.itemCount <= 0 ||
      !artifact.dossier.recommendation.feedFunctional ||
      artifact.replay.replayId !== 'inspect_startup_order' ||
      !artifact.replay.report.collectorBeforeHydration ||
      !artifact.replay.report.activityBeforePreferenceRead ||
      artifact.replay.report.activityRequestCount !== 1 ||
      artifact.replay.report.activityReceiptCount !== 1
    ) {
      invalid('The startup-order cohort lacked its complete factual signature.');
    }
  } else if (
    canonicalJson(failedClauses) !==
      canonicalJson(['preference_survives_reload']) ||
    canonicalJson(
      artifact.dossier.contractClauses.map((clause) => clause.met),
    ) !== canonicalJson([true, true, false]) ||
    artifact.dossier.uiState.preference !== 'off' ||
    artifact.dossier.uiState.toggleChecked ||
    artifact.dossier.browserStorageState.preference !== 'off' ||
    artifact.dossier.backendPreferenceState.preference !== 'on' ||
    artifact.dossier.activity.requestCount !== 0 ||
    artifact.dossier.activity.identifiableRequestCount !== 0 ||
    artifact.dossier.activity.receiptCount !== 0 ||
    artifact.dossier.activity.identifiableReceiptCount !== 0 ||
    artifact.dossier.recommendation.mode !== 'contextual' ||
    artifact.dossier.recommendation.itemCount <= 0 ||
    !artifact.dossier.recommendation.feedFunctional ||
    artifact.replay.replayId !== 'inspect_preference_roundtrip' ||
    artifact.replay.report.requested !== 'off' ||
    artifact.replay.report.acknowledged !== 'off' ||
    artifact.replay.report.authoritativeReadback !== 'on' ||
    !artifact.replay.report.receiptRecorded ||
    !artifact.replay.report.identityCorrelated ||
    artifact.replay.report.roundtripConsistent
  ) {
    invalid('The preference-roundtrip cohort lacked its complete factual signature.');
  }
}

function assertNoBoundaryLeak(
  artifact: CompletedLiveArtifact,
  credentials: readonly string[],
): void {
  const serialized = JSON.stringify(artifact);
  for (const forbidden of FORBIDDEN_BOUNDARY_PATTERNS) {
    if (forbidden.test(serialized)) {
      invalid('A forbidden fixture, environment, or credential marker was retained.');
    }
  }
  if (credentials.some((credential) => serialized.includes(credential))) {
    invalid('The configured API credential was retained in an artifact.');
  }
  if (containsAuthoritativeOutcomeLanguage(artifact.initialOutput)) {
    invalid('Initial model prose contained a reserved product-outcome claim.');
  }
}

function verifyArtifact(
  raw: unknown,
  expectation: EvidenceExpectation,
  credentials: readonly string[],
): CompletedLiveArtifact {
  const parsed = completedLiveArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    invalid('A retained live artifact failed its strict schema.');
  }
  const artifact = parsed.data;
  if (artifact.dossierSha256 !== sha256CanonicalJson(artifact.dossier)) {
    invalid('The dossier digest did not match the retained dossier.');
  }
  const startedAt = new Date(artifact.timing.startedAt).getTime();
  const completedAt = new Date(artifact.timing.completedAt).getTime();
  if (
    completedAt < startedAt ||
    artifact.timing.replayMs > artifact.timing.totalMs
  ) {
    invalid('Artifact timing was reversed or internally inconsistent.');
  }
  assertResponseShapes(artifact);
  assertEqualUsage(
    artifact.provider.aggregateUsage,
    sumUsage(artifact.provider.responses),
    'Artifact',
  );
  assertValidationSequence(artifact);
  assertInitialGrounding(artifact);
  assertNormalizedReplay(artifact);
  assertExpectedEvidence(artifact, expectation);
  assertHypothesisContinuity(artifact);
  assertNoBoundaryLeak(artifact, credentials);
  return artifact;
}

function assertUnique(values: readonly string[], context: string): void {
  if (new Set(values).size !== values.length) {
    invalid(`${context} were not unique within the retained cohort.`);
  }
}

function buildRunReceipt(artifact: CompletedLiveArtifact) {
  return {
    investigationId: artifact.investigationId,
    canonicalArtifactSha256: sha256CanonicalJson(artifact),
    dossierSha256: artifact.dossierSha256,
    completedAt: artifact.timing.completedAt,
    leadingHypothesisId:
      artifact.finalOutput
        .mostLikelyHypothesisId as InvestigationHypothesisIdV1,
    responses: artifact.provider.responses.map((response) => ({
      phase: response.phase,
      responseId: response.responseId,
      model: response.model,
      status: response.status,
      latencyMs: response.latencyMs,
      usage: { ...response.usage },
      outputItems: response.outputItems.map((item) => ({
        type: item.type,
        status: item.status,
        contentTypes: [...item.contentTypes],
      })),
    })),
  };
}

export function verifyLiveStabilityArtifacts(inputs: LiveStabilityInputs) {
  if (
    inputs.raceArtifacts.length !== EXPECTED_RUNS_PER_SIGNATURE ||
    inputs.propagationArtifacts.length !== EXPECTED_RUNS_PER_SIGNATURE
  ) {
    invalid('Exactly three retained artifacts per evidence signature are required.');
  }
  if (!sourceSnapshotSchema.safeParse(inputs.sourceSnapshot).success) {
    invalid('The execution source snapshot was absent or invalid.');
  }

  const credentials = credentialCandidates(inputs);

  const race = inputs.raceArtifacts.map((artifact) =>
    verifyArtifact(artifact, RACE_EXPECTATION, credentials),
  );
  const propagation = inputs.propagationArtifacts.map((artifact) =>
    verifyArtifact(artifact, PROPAGATION_EXPECTATION, credentials),
  );
  const all = [...race, ...propagation];
  assertUnique(
    all.map((artifact) => artifact.investigationId),
    'Investigation IDs',
  );
  assertUnique(
    all.flatMap((artifact) =>
      artifact.provider.responses.map((response) => response.responseId),
    ),
    'Response IDs',
  );

  for (const cohort of [race, propagation]) {
    if (new Set(cohort.map((artifact) => artifact.dossierSha256)).size !== 1) {
      invalid('A defect cohort did not retain one deterministic dossier digest.');
    }
  }
  if (race[0]?.dossierSha256 === propagation[0]?.dossierSha256) {
    invalid('The two defect cohorts unexpectedly shared one dossier digest.');
  }
  const aggregateUsage = sumUsage(
    all.flatMap((artifact) => artifact.provider.responses),
  );
  const aggregateLatencyMs = all.reduce(
    (total, artifact) =>
      total +
      artifact.provider.responses.reduce(
        (subtotal, response) => subtotal + response.latencyMs,
        0,
      ),
    0,
  );
  const groupReceipt = (
    expectation: EvidenceExpectation,
    artifacts: CompletedLiveArtifact[],
  ) => {
    const responses = artifacts.flatMap(
      (artifact) => artifact.provider.responses,
    );
    return {
      evidenceSignature: expectation.evidenceSignature,
      expectedViolationCode: expectation.violationCode,
      selectedReplay: expectation.replayId,
      verifiedFactualSignature:
        expectation.replayId === 'inspect_startup_order'
          ? {
              failedClauseId: 'no_identifiable_activity' as const,
              identifiableActivityRequests: 1 as const,
              identifiableActivityReceipts: 1 as const,
              collectorBeforeHydration: true as const,
              activityBeforePreferenceRead: true as const,
            }
          : {
              failedClauseId: 'preference_survives_reload' as const,
              requested: 'off' as const,
              acknowledged: 'off' as const,
              authoritativeReadback: 'on' as const,
              receiptRecorded: true as const,
              identityCorrelated: true as const,
              roundtripConsistent: false as const,
            },
      dossierSha256: artifacts[0]!.dossierSha256,
      runCount: artifacts.length,
      responseCount: responses.length,
      aggregateUsage: sumUsage(responses),
      aggregateLatencyMs: responses.reduce(
        (total, response) => total + response.latencyMs,
        0,
      ),
      runs: artifacts.map(buildRunReceipt),
    };
  };

  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    verificationScope: 'six_retained_live_stability_runs' as const,
    configuredProviderBaseUrl: OPENAI_API_BASE_URL,
    requestedModel: MODEL_ID,
    promptVersion: PROMPT_VERSION,
    productVerdictAuthority:
      'deterministic_typescript_and_playwright_only' as const,
    artifactIntegrityMeaning:
      'canonical_sha256_consistency_not_provider_origin_attestation' as const,
    sourceSnapshotMeaning:
      'pre_run_and_post_run_canonical_file_manifest_match' as const,
    responseIdUniquenessScope: 'retained_six_run_cohort' as const,
    sourceSnapshotSha256: inputs.sourceSnapshot.sha256,
    sourceFileCount: inputs.sourceSnapshot.fileCount,
    requiredRunsPerEvidenceSignature: EXPECTED_RUNS_PER_SIGNATURE,
    totalRuns: all.length,
    totalResponses: all.length * 2,
    aggregateUsage,
    aggregateLatencyMs,
    groups: [
      groupReceipt(RACE_EXPECTATION, race),
      groupReceipt(PROPAGATION_EXPECTATION, propagation),
    ],
  };
  const serializedReceipt = JSON.stringify(receipt);
  if (
    credentials.some((credential) => serializedReceipt.includes(credential)) ||
    /(?:OPENAI_API_KEY|Bearer\s)/.test(serializedReceipt)
  ) {
    invalid('The sanitized receipt contained a credential marker.');
  }
  return receipt;
}

async function collectExactArtifacts(
  root: string,
  current: string,
  matches: string[],
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() !== 'attachments') {
        await collectExactArtifacts(root, path, matches);
      }
      continue;
    }
    if (
      entry.isFile() &&
      entry.name === ARTIFACT_BASENAME &&
      resolve(path).startsWith(`${resolve(root)}${sep}`)
    ) {
      matches.push(path);
    }
  }
}

export async function discoverLiveArtifacts(outputDirectory: string): Promise<string[]> {
  const matches: string[] = [];
  try {
    await collectExactArtifacts(outputDirectory, outputDirectory, matches);
  } catch (error) {
    if (isStabilityError(error)) {
      throw error;
    }
    invalid('A stability output directory was absent or unreadable.');
  }
  matches.sort();
  if (
    matches.length !== EXPECTED_RUNS_PER_SIGNATURE ||
    new Set(matches.map((path) => dirname(path))).size !== matches.length
  ) {
    invalid('A stability output directory did not contain three distinct exact artifacts.');
  }
  return matches;
}

export async function requirePassedLastRun(outputDirectory: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(outputDirectory, '.last-run.json'), 'utf8'),
    );
  } catch {
    invalid('A stability output directory had no readable last-run result.');
  }
  if (!lastRunSchema.safeParse(parsed).success) {
    invalid('Playwright did not record a clean passed stability invocation.');
  }
}

async function walkFiles(current: string, files: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
}

export async function computeSourceSnapshot(projectRoot: string): Promise<SourceSnapshot> {
  try {
    const files: string[] = [];
    for (const directory of ['src', 'tests', 'scripts']) {
      await walkFiles(join(projectRoot, directory), files);
    }
    for (const filename of [
      'index.html',
      'package.json',
      'package-lock.json',
      'playwright.config.ts',
      'tsconfig.json',
      'vite.config.ts',
    ]) {
      files.push(join(projectRoot, filename));
    }
    const manifest = await Promise.all(
      files
        .filter((path) => extname(path) !== '.map')
        .sort()
        .map(async (path) => ({
          path: relative(projectRoot, path).split(sep).join('/'),
          sha256: sha256Bytes(await readFile(path)),
        })),
    );
    const snapshot = {
      sha256: sha256CanonicalJson(manifest),
      fileCount: manifest.length,
    };
    if (!sourceSnapshotSchema.safeParse(snapshot).success) {
      invalid('The execution source snapshot was empty or invalid.');
    }
    return snapshot;
  } catch (error) {
    if (isStabilityError(error)) {
      throw error;
    }
    invalid('The execution source snapshot could not be computed.');
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function captureLiveSourceSnapshot(
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
): Promise<string> {
  const outputPath = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.sourceSnapshot,
  );
  const staleReceiptPath = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.receipt,
  );
  const staleRaceOutputPath = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.race,
  );
  const stalePropagationOutputPath = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.propagation,
  );
  await Promise.all([
    rm(staleReceiptPath, { force: true }),
    rm(outputPath, { force: true }),
    rm(staleRaceOutputPath, { recursive: true, force: true }),
    rm(stalePropagationOutputPath, { recursive: true, force: true }),
  ]);
  const snapshot = await computeSourceSnapshot(projectRoot);
  try {
    await writeJsonAtomically(outputPath, {
      schemaVersion: SOURCE_SNAPSHOT_SCHEMA_VERSION,
      snapshot,
    });
  } catch {
    invalid('The pre-run execution source snapshot could not be written.');
  }
  return outputPath;
}

export async function requireUnchangedSourceSnapshot(
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
): Promise<SourceSnapshot> {
  const inputPath = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.sourceSnapshot,
  );
  let raw: string;
  try {
    raw = await readFile(inputPath, 'utf8');
  } catch {
    invalid('The required pre-run execution source snapshot was absent.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid('The pre-run execution source snapshot was not valid JSON.');
  }
  const captured = capturedSourceSnapshotSchema.safeParse(parsed);
  if (!captured.success) {
    invalid('The pre-run execution source snapshot was invalid.');
  }
  const current = await computeSourceSnapshot(projectRoot);
  if (canonicalJson(current) !== canonicalJson(captured.data.snapshot)) {
    invalid('Execution sources changed after the live-stability preflight.');
  }
  return current;
}

async function readJsonFiles(
  paths: readonly string[],
  credentials: readonly string[],
): Promise<unknown[]> {
  return Promise.all(
    paths.map(async (path) => {
      const raw = await readFile(path, 'utf8');
      if (credentials.some((credential) => raw.includes(credential))) {
        invalid('The configured API credential was retained in a raw artifact.');
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        invalid('A retained live artifact was not valid JSON.');
      }
    }),
  );
}

export async function runLiveStabilityVerification(
  projectRoot = fileURLToPath(new URL('..', import.meta.url)),
): Promise<string> {
  const rawApiKey = process.env.OPENAI_API_KEY;
  const trimmedApiKey = rawApiKey?.trim();
  if (rawApiKey === undefined || trimmedApiKey === undefined || trimmedApiKey.length === 0) {
    invalid('OPENAI_API_KEY is required only to check that it was not retained.');
  }
  const credentials = credentialCandidates({
    credentialCandidates: [rawApiKey, trimmedApiKey],
  });
  const raceDirectory = resolve(projectRoot, DEFAULT_STABILITY_PATHS.race);
  const propagationDirectory = resolve(
    projectRoot,
    DEFAULT_STABILITY_PATHS.propagation,
  );
  const outputPath = resolve(projectRoot, DEFAULT_STABILITY_PATHS.receipt);
  await rm(outputPath, { force: true });
  const sourceSnapshot = await requireUnchangedSourceSnapshot(projectRoot);
  await Promise.all([
    requirePassedLastRun(raceDirectory),
    requirePassedLastRun(propagationDirectory),
  ]);
  const [racePaths, propagationPaths] = await Promise.all([
    discoverLiveArtifacts(raceDirectory),
    discoverLiveArtifacts(propagationDirectory),
  ]);
  const [raceArtifacts, propagationArtifacts] = await Promise.all([
    readJsonFiles(racePaths, credentials),
    readJsonFiles(propagationPaths, credentials),
  ]);
  const receipt = verifyLiveStabilityArtifacts({
    raceArtifacts,
    propagationArtifacts,
    sourceSnapshot,
    credentialCandidates: credentials,
  });
  try {
    await writeJsonAtomically(outputPath, receipt);
  } catch {
    invalid('The sanitized live-stability receipt could not be written.');
  }
  return outputPath;
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = process.argv.slice(2);
  const operation =
    args.length === 0
      ? runLiveStabilityVerification()
      : args.length === 1 && args[0] === '--capture-source-snapshot'
        ? captureLiveSourceSnapshot()
        : Promise.reject(
            new Error(
              'PP_LIVE_STABILITY_INVALID: expected no argument or --capture-source-snapshot.',
            ),
          );
  operation
    .then((outputPath) => {
      console.log(
        args[0] === '--capture-source-snapshot'
          ? `Live stability preflight captured: ${outputPath}`
          : `Live stability verification passed; sanitized receipt: ${outputPath}`,
      );
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error
          ? error.message
          : 'PP_LIVE_STABILITY_INVALID: unknown verification failure';
      console.error(message);
      process.exitCode = 1;
    });
}
