import { z } from 'zod';

import {
  ALLOWED_RETURNED_REPAIR_MODELS,
  CANONICAL_ARTIFACT_INTEGRITY_MEANING,
  CANONICAL_PROMISE_AUTHORITY,
  CANONICAL_SOURCE_SNAPSHOT_MEANING,
  LIVE_STABILITY_RECEIPT_SCHEMA_VERSION,
  PROPAGATION_EVIDENCE_SIGNATURE,
  PROPAGATION_REPLAY_ID,
  PROPAGATION_VIOLATION_CODE,
  RACE_EVIDENCE_SIGNATURE,
  RACE_FAILED_CLAUSE_ID,
  RACE_REPLAY_ID,
  RACE_VIOLATION_CODE,
  REPAIR_CANDIDATE_SCHEMA_VERSION,
  REPAIR_HYPOTHESIS_IDS,
  REQUESTED_REPAIR_MODEL,
  RETAINED_RESPONSE_ID_SCOPE,
  type RaceRepairCandidateV1,
} from './contracts.js';

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,128}$/;

const sha256Schema = z.string().regex(SHA256);
const returnedModelSchema = z.enum(ALLOWED_RETURNED_REPAIR_MODELS);
const hypothesisIdSchema = z.enum(REPAIR_HYPOTHESIS_IDS);

const tokenUsageSchema = z
  .object({
    inputTokens: z.number().int().positive(),
    cachedInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().positive(),
    reasoningTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().positive(),
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
        message: 'Token usage is internally inconsistent.',
      });
    }
  });

type TokenUsage = z.infer<typeof tokenUsageSchema>;

const reasoningOutputItemSchema = z
  .object({
    type: z.literal('reasoning'),
    status: z.union([z.literal('completed'), z.null()]),
    contentTypes: z.array(z.never()).length(0),
  })
  .strict();

const replayCallOutputItemSchema = z
  .object({
    type: z.literal('function_call'),
    status: z.literal('completed'),
    contentTypes: z.array(z.never()).length(0),
  })
  .strict();

const finalMessageOutputItemSchema = z
  .object({
    type: z.literal('message'),
    status: z.literal('completed'),
    contentTypes: z.tuple([z.literal('output_text')]),
  })
  .strict();

const replaySelectionResponseSchema = z
  .object({
    phase: z.literal('replay_selection'),
    responseId: z.string().regex(SAFE_IDENTIFIER),
    model: returnedModelSchema,
    status: z.literal('completed'),
    latencyMs: z.number().finite().nonnegative(),
    usage: tokenUsageSchema,
    outputItems: z.union([
      z.tuple([replayCallOutputItemSchema]),
      z.tuple([reasoningOutputItemSchema, replayCallOutputItemSchema]),
    ]),
  })
  .strict();

const hypothesisUpdateResponseSchema = z
  .object({
    phase: z.literal('hypothesis_update'),
    responseId: z.string().regex(SAFE_IDENTIFIER),
    model: returnedModelSchema,
    status: z.literal('completed'),
    latencyMs: z.number().finite().nonnegative(),
    usage: tokenUsageSchema,
    outputItems: z.union([
      z.tuple([finalMessageOutputItemSchema]),
      z.tuple([reasoningOutputItemSchema, finalMessageOutputItemSchema]),
    ]),
  })
  .strict();

const liveRunReceiptSchema = z
  .object({
    investigationId: z.string().uuid(),
    canonicalArtifactSha256: sha256Schema,
    dossierSha256: sha256Schema,
    completedAt: z.string().datetime(),
    leadingHypothesisId: hypothesisIdSchema,
    responses: z.tuple([
      replaySelectionResponseSchema,
      hypothesisUpdateResponseSchema,
    ]),
  })
  .strict();

type LiveRunReceipt = z.infer<typeof liveRunReceiptSchema>;

interface RefinementContext {
  addIssue(issue: {
    code: 'custom';
    path?: Array<string | number>;
    message: string;
  }): void;
}

function sumUsage(responses: ReadonlyArray<{ usage: TokenUsage }>): TokenUsage {
  return responses.reduce<TokenUsage>(
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

function sameUsage(left: TokenUsage, right: TokenUsage): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens &&
    left.totalTokens === right.totalTokens
  );
}

function latencyMatches(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000_001;
}

function refineGroupAggregates(
  group: {
    dossierSha256: string;
    runCount: number;
    responseCount: number;
    aggregateUsage: TokenUsage;
    aggregateLatencyMs: number;
    runs: LiveRunReceipt[];
  },
  context: RefinementContext,
): void {
  const responses = group.runs.flatMap((run) => run.responses);
  if (
    group.runCount !== group.runs.length ||
    group.responseCount !== responses.length
  ) {
    context.addIssue({
      code: 'custom',
      path: ['runCount'],
      message: 'Declared group counts do not match retained runs.',
    });
  }
  if (group.runs.some((run) => run.dossierSha256 !== group.dossierSha256)) {
    context.addIssue({
      code: 'custom',
      path: ['dossierSha256'],
      message: 'The dossier hash is not stable across the group.',
    });
  }
  if (!sameUsage(group.aggregateUsage, sumUsage(responses))) {
    context.addIssue({
      code: 'custom',
      path: ['aggregateUsage'],
      message: 'Group token usage does not match retained responses.',
    });
  }
  const latency = responses.reduce(
    (total, response) => total + response.latencyMs,
    0,
  );
  if (!latencyMatches(group.aggregateLatencyMs, latency)) {
    context.addIssue({
      code: 'custom',
      path: ['aggregateLatencyMs'],
      message: 'Group latency does not match retained responses.',
    });
  }
}

export const raceStabilityGroupV1Schema = z
  .object({
    evidenceSignature: z.literal(RACE_EVIDENCE_SIGNATURE),
    expectedViolationCode: z.literal(RACE_VIOLATION_CODE),
    selectedReplay: z.literal(RACE_REPLAY_ID),
    verifiedFactualSignature: z
      .object({
        failedClauseId: z.literal(RACE_FAILED_CLAUSE_ID),
        identifiableActivityRequests: z.literal(1),
        identifiableActivityReceipts: z.literal(1),
        collectorBeforeHydration: z.literal(true),
        activityBeforePreferenceRead: z.literal(true),
      })
      .strict(),
    dossierSha256: sha256Schema,
    runCount: z.literal(3),
    responseCount: z.literal(6),
    aggregateUsage: tokenUsageSchema,
    aggregateLatencyMs: z.number().finite().positive(),
    runs: z.array(liveRunReceiptSchema).length(3),
  })
  .strict()
  .superRefine(refineGroupAggregates);

export const propagationStabilityGroupV1Schema = z
  .object({
    evidenceSignature: z.literal(PROPAGATION_EVIDENCE_SIGNATURE),
    expectedViolationCode: z.literal(PROPAGATION_VIOLATION_CODE),
    selectedReplay: z.literal(PROPAGATION_REPLAY_ID),
    verifiedFactualSignature: z
      .object({
        failedClauseId: z.literal('preference_survives_reload'),
        requested: z.literal('off'),
        acknowledged: z.literal('off'),
        authoritativeReadback: z.literal('on'),
        receiptRecorded: z.literal(true),
        identityCorrelated: z.literal(true),
        roundtripConsistent: z.literal(false),
      })
      .strict(),
    dossierSha256: sha256Schema,
    runCount: z.literal(3),
    responseCount: z.literal(6),
    aggregateUsage: tokenUsageSchema,
    aggregateLatencyMs: z.number().finite().positive(),
    runs: z.array(liveRunReceiptSchema).length(3),
  })
  .strict()
  .superRefine(refineGroupAggregates);

export const liveStabilityReceiptV1Schema = z
  .object({
    schemaVersion: z.literal(LIVE_STABILITY_RECEIPT_SCHEMA_VERSION),
    verificationScope: z.literal('six_retained_live_stability_runs'),
    configuredProviderBaseUrl: z.literal('https://api.openai.com/v1'),
    requestedModel: z.literal(REQUESTED_REPAIR_MODEL),
    promptVersion: z.literal('promiseproof.investigation-prompt.v1'),
    productVerdictAuthority: z.literal(CANONICAL_PROMISE_AUTHORITY),
    artifactIntegrityMeaning: z.literal(
      CANONICAL_ARTIFACT_INTEGRITY_MEANING,
    ),
    sourceSnapshotMeaning: z.literal(CANONICAL_SOURCE_SNAPSHOT_MEANING),
    responseIdUniquenessScope: z.literal(RETAINED_RESPONSE_ID_SCOPE),
    sourceSnapshotSha256: sha256Schema,
    sourceFileCount: z.number().int().positive(),
    requiredRunsPerEvidenceSignature: z.literal(3),
    totalRuns: z.literal(6),
    totalResponses: z.literal(12),
    aggregateUsage: tokenUsageSchema,
    aggregateLatencyMs: z.number().finite().positive(),
    groups: z.tuple([
      raceStabilityGroupV1Schema,
      propagationStabilityGroupV1Schema,
    ]),
  })
  .strict()
  .superRefine((receipt, context) => {
    const runs = receipt.groups.flatMap((group) => group.runs);
    const responses = runs.flatMap((run) => run.responses);
    const investigationIds = runs.map((run) => run.investigationId);
    const responseIds = responses.map((response) => response.responseId);
    const artifactHashes = runs.map((run) => run.canonicalArtifactSha256);

    if (
      receipt.totalRuns !== runs.length ||
      receipt.totalResponses !== responses.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['totalRuns'],
        message: 'Receipt totals do not match retained cohorts.',
      });
    }
    if (new Set(investigationIds).size !== investigationIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: 'Investigation IDs must be unique across the retained receipt.',
      });
    }
    if (new Set(responseIds).size !== responseIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: 'Response IDs must be unique across the retained receipt.',
      });
    }
    if (new Set(artifactHashes).size !== artifactHashes.length) {
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: 'Canonical artifact hashes must be unique across retained runs.',
      });
    }
    if (receipt.groups[0].dossierSha256 === receipt.groups[1].dossierSha256) {
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: 'The two evidence signatures must retain distinct dossiers.',
      });
    }
    if (!sameUsage(receipt.aggregateUsage, sumUsage(responses))) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateUsage'],
        message: 'Receipt token usage does not match retained responses.',
      });
    }
    const latency = responses.reduce(
      (total, response) => total + response.latencyMs,
      0,
    );
    if (!latencyMatches(receipt.aggregateLatencyMs, latency)) {
      context.addIssue({
        code: 'custom',
        path: ['aggregateLatencyMs'],
        message: 'Receipt latency does not match retained responses.',
      });
    }
  });

export type LiveStabilityReceiptV1 = z.infer<
  typeof liveStabilityReceiptV1Schema
>;

export const raceRepairCandidateV1Schema = z
  .object({
    schemaVersion: z.literal(REPAIR_CANDIDATE_SCHEMA_VERSION),
    candidateKind: z.literal('startup_order_repair'),
    promiseAuthority: z.literal(CANONICAL_PROMISE_AUTHORITY),
    source: z
      .object({
        receiptSchemaVersion: z.literal(
          LIVE_STABILITY_RECEIPT_SCHEMA_VERSION,
        ),
        canonicalReceiptSha256: sha256Schema,
        sourceSnapshotSha256: sha256Schema,
        sourceSnapshotMeaning: z.literal(CANONICAL_SOURCE_SNAPSHOT_MEANING),
        artifactIntegrityMeaning: z.literal(
          CANONICAL_ARTIFACT_INTEGRITY_MEANING,
        ),
      })
      .strict(),
    evidence: z
      .object({
        evidenceSignature: z.literal(RACE_EVIDENCE_SIGNATURE),
        violationCode: z.literal(RACE_VIOLATION_CODE),
        selectedReplay: z.literal(RACE_REPLAY_ID),
        dossierSha256: sha256Schema,
        investigationIdCohortSha256: sha256Schema,
        responseIdCohortSha256: sha256Schema,
        canonicalArtifactSha256s: z.array(sha256Schema).length(3),
        leadingHypothesisIds: z.array(hypothesisIdSchema).length(3),
        returnedModels: z.array(returnedModelSchema).length(6),
        runCount: z.literal(3),
        responseCount: z.literal(6),
        facts: z
          .object({
            failedClauseId: z.literal(RACE_FAILED_CLAUSE_ID),
            identifiableActivityRequests: z.literal(1),
            identifiableActivityReceipts: z.literal(1),
            collectorBeforeHydration: z.literal(true),
            activityBeforePreferenceRead: z.literal(true),
          })
          .strict(),
      })
      .strict()
      .superRefine((evidence, context) => {
        if (
          new Set(evidence.canonicalArtifactSha256s).size !==
          evidence.canonicalArtifactSha256s.length
        ) {
          context.addIssue({
            code: 'custom',
            path: ['canonicalArtifactSha256s'],
            message: 'Candidate artifact hashes must be unique.',
          });
        }
      }),
    deterministicChecks: z
      .object({
        stableDossierAcrossRuns: z.literal(true),
        uniqueInvestigationIds: z.literal(true),
        uniqueResponseIds: z.literal(true),
        completedAllowlistedResponsesOnly: z.literal(true),
        modelVerdictUsed: z.literal(false),
      })
      .strict(),
  })
  .strict();

const candidateTypeCheck: z.infer<
  typeof raceRepairCandidateV1Schema
> extends RaceRepairCandidateV1
  ? true
  : false = true;

void candidateTypeCheck;
