import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { canonicalJson, sha256CanonicalJson } from '../investigation/canonical-json.js';
import { deepFreeze } from '../investigation/immutable.js';
import type { RaceRepairCandidateV1 } from './contracts.js';
import {
  frozenFoundationSchema,
  type FrozenFoundationV1,
} from './foundation.js';
import type { GitRefState } from './git.js';
import {
  CODEX_REPAIR_CLI_VERSION,
  CODEX_REPAIR_MODEL,
  CODEX_REPAIR_SDK_VERSION,
  REPAIR_COMMAND_CLASSES,
  REPAIR_COMMAND_EXIT_DISPOSITIONS,
  REPAIR_COMMAND_FAILURE_REASONS,
  repairAgentSummarySchema,
  type RepairProviderResult,
  type SafeRepairProviderFailure,
} from './provider.js';
import { raceRepairCandidateV1Schema } from './schemas.js';

export const REPAIR_LOCAL_STATE_VERSION =
  'promiseproof.repair-local-state.v1' as const;
export const REPAIR_LIFECYCLE_VERSION =
  'promiseproof.repair-lifecycle.v1' as const;

export const REPAIR_STATES = [
  'created',
  'baseline_verified',
  'codex_completed',
  'candidate_policy_accepted',
  'awaiting_human_review',
  'human_approved',
  'human_rejected',
  'retired_without_verification',
  'verification_started',
  'verification_passed',
  'verification_failed',
  'evidence_saved',
  'cleanup_completed',
  'cleanup_failed',
] as const;

export type RepairStateName = (typeof REPAIR_STATES)[number];

const ALLOWED_REPAIR_TRANSITIONS: Readonly<
  Record<RepairStateName, readonly RepairStateName[]>
> = Object.freeze({
  created: ['baseline_verified', 'evidence_saved', 'cleanup_failed'],
  baseline_verified: ['codex_completed', 'evidence_saved', 'cleanup_failed'],
  codex_completed: [
    'candidate_policy_accepted',
    'evidence_saved',
    'cleanup_failed',
  ],
  candidate_policy_accepted: [
    'awaiting_human_review',
    'evidence_saved',
    'cleanup_failed',
  ],
  awaiting_human_review: ['human_approved', 'human_rejected'],
  human_approved: ['retired_without_verification', 'verification_started'],
  human_rejected: ['evidence_saved'],
  retired_without_verification: ['evidence_saved'],
  verification_started: ['verification_passed', 'verification_failed'],
  verification_passed: ['evidence_saved'],
  verification_failed: ['evidence_saved'],
  evidence_saved: ['cleanup_completed', 'cleanup_failed'],
  cleanup_failed: ['cleanup_completed'],
  cleanup_completed: [],
});

export interface RepairPatchRecord {
  sha256: string;
  bytes: number;
  additions: number;
  deletions: number;
  changedFiles: Array<{
    path: string;
    status: 'modified' | 'added';
    beforeSha256: string | null;
    afterSha256: string;
  }>;
}

export interface LocalRepairStateV1 {
  schemaVersion: typeof REPAIR_LOCAL_STATE_VERSION;
  repairId: string;
  state: RepairStateName;
  createdAt: string;
  updatedAt: string;
  projectRoot: string;
  artifactDirectory: string;
  lifecyclePath: string;
  patchPath: string;
  approvalPath: string;
  candidateWorktreePath: string;
  verificationWorktreePath: string | null;
  codexHomePath: string;
  toolTempPath: string;
  baseCommit: string;
  baseTree: string;
  baseHeadRef: string | null;
  baseRefState: GitRefState;
  milestoneTag: 'milestone-03-gpt56-investigation';
  frozenFoundation: FrozenFoundationV1;
  eligibility: RaceRepairCandidateV1;
  promptEnvelopeSha256: string;
  provider: RepairProviderResult | null;
  providerFailure: SafeRepairProviderFailure | null;
  failure: {
    stage: string;
    code: string;
    message: string;
    recordedAt: string;
  } | null;
  patch: RepairPatchRecord | null;
  approvalSha256: string | null;
  verificationReceiptPath: string | null;
  verificationReceiptSha256: string | null;
}

export interface RepairLifecycleEventV1 {
  sequence: number;
  repairId: string;
  state: RepairStateName;
  recordedAt: string;
  previousEventSha256: string | null;
  payloadSha256: string;
  eventSha256: string;
}

export interface RepairLifecycleV1 {
  schemaVersion: typeof REPAIR_LIFECYCLE_VERSION;
  repairId: string;
  events: RepairLifecycleEventV1[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const PP_CODE = /^PP_[A-Z0-9_]+$/;
const absolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value) && path.normalize(value) === value, {
    message: 'Expected a normalized absolute path.',
  });
const sha256Schema = z.string().regex(SHA256);
const countMapSchema = z.record(
  z.string().min(1).max(128),
  z.number().int().nonnegative(),
);

const refStateSchema = z
  .object({
    refs: z.array(
      z
        .object({
          name: z.string().startsWith('refs/'),
          objectId: z.string().regex(GIT_OBJECT_ID),
          symbolicTarget: z.string().startsWith('refs/').nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const providerResultSchema = z
  .object({
    kind: z.enum(['openai-codex-sdk', 'offline-deterministic']),
    requestedModel: z.enum([CODEX_REPAIR_MODEL, 'offline-codex-fixture']),
    sdkVersion: z.string().min(1).max(64),
    cliVersion: z.string().min(1).max(64),
    threadId: z.string().min(1).max(128),
    turnsUsed: z.literal(1),
    summary: repairAgentSummarySchema,
    finalResponseSha256: sha256Schema,
    usage: z
      .object({
        inputTokens: z.number().int().positive(),
        cachedInputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().positive(),
        reasoningTokens: z.number().int().nonnegative(),
      })
      .strict(),
    events: z
      .object({
        eventCount: z.number().int().positive().max(2_000),
        serializedBytesObserved: z.number().int().positive().max(2 * 1024 * 1024),
        eventTypeCounts: countMapSchema,
        completedItemTypeCounts: countMapSchema,
        completedCommandCount: z.number().int().nonnegative(),
        completedFileChangeCount: z.number().int().nonnegative(),
        observedFilePaths: z.array(z.string().min(1).max(260)).max(2),
        sanitizedSequenceSha256: sha256Schema,
      })
      .strict(),
    timing: z
      .object({
        startedAt: z.string().datetime(),
        completedAt: z.string().datetime(),
        totalMs: z.number().int().nonnegative(),
      })
      .strict(),
    validationCodes: z.array(z.string().regex(PP_CODE)).min(1).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.usage.cachedInputTokens > value.usage.inputTokens ||
      value.usage.reasoningTokens > value.usage.outputTokens
    ) {
      context.addIssue({
        code: 'custom',
        path: ['usage'],
        message: 'Provider token usage is internally inconsistent.',
      });
    }
    if (
      value.kind === 'openai-codex-sdk' &&
      (value.requestedModel !== CODEX_REPAIR_MODEL ||
        value.sdkVersion !== CODEX_REPAIR_SDK_VERSION ||
        value.cliVersion !== CODEX_REPAIR_CLI_VERSION)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Live provider metadata differs from the pinned Codex boundary.',
      });
    }
    if (
      value.kind === 'offline-deterministic' &&
      value.requestedModel !== 'offline-codex-fixture'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Offline provider metadata is inconsistent.',
      });
    }
  });

const commandFailureDiagnosticSchema = z
  .object({
    commandClass: z.enum(REPAIR_COMMAND_CLASSES),
    exitDisposition: z.enum(REPAIR_COMMAND_EXIT_DISPOSITIONS),
    exitCode: z.number().int().safe().nullable(),
    outputBytes: z.number().int().nonnegative().max(2 * 1024 * 1024),
    reason: z.enum(REPAIR_COMMAND_FAILURE_REASONS),
  })
  .strict();

const providerFailureSchema = z
  .object({
    code: z.string().regex(PP_CODE),
    message: z.string().min(1).max(1_000),
    eventCount: z.number().int().nonnegative().max(2_000),
    serializedBytesObserved: z.number().int().nonnegative().max(2 * 1024 * 1024),
    commandFailure: commandFailureDiagnosticSchema.optional(),
  })
  .strict();

const orchestrationFailureSchema = z
  .object({
    stage: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    code: z.string().regex(PP_CODE),
    message: z.string().min(1).max(1_000),
    recordedAt: z.string().datetime(),
  })
  .strict();

const patchRecordSchema = z
  .object({
    sha256: sha256Schema,
    bytes: z.number().int().positive().max(32 * 1024),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFiles: z.tuple([
      z
        .object({
          path: z.literal('src/client/main.ts'),
          status: z.literal('modified'),
          beforeSha256: sha256Schema,
          afterSha256: sha256Schema,
        })
        .strict(),
      z
        .object({
          path: z.literal('tests/regression/initialization-order.spec.ts'),
          status: z.literal('added'),
          beforeSha256: z.null(),
          afterSha256: sha256Schema,
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.additions + value.deletions > 160) {
      context.addIssue({
        code: 'custom',
        path: ['additions'],
        message: 'Patch changed-line count exceeds the repair boundary.',
      });
    }
  });

export const localRepairStateSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_LOCAL_STATE_VERSION),
    repairId: z.string().uuid(),
    state: z.enum(REPAIR_STATES),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    projectRoot: absolutePathSchema,
    artifactDirectory: absolutePathSchema,
    lifecyclePath: absolutePathSchema,
    patchPath: absolutePathSchema,
    approvalPath: absolutePathSchema,
    candidateWorktreePath: absolutePathSchema,
    verificationWorktreePath: absolutePathSchema.nullable(),
    codexHomePath: absolutePathSchema,
    toolTempPath: absolutePathSchema,
    baseCommit: z.string().regex(GIT_OBJECT_ID),
    baseTree: z.string().regex(GIT_OBJECT_ID),
    baseHeadRef: z.string().startsWith('refs/').nullable(),
    baseRefState: refStateSchema,
    milestoneTag: z.literal('milestone-03-gpt56-investigation'),
    frozenFoundation: frozenFoundationSchema,
    eligibility: raceRepairCandidateV1Schema,
    promptEnvelopeSha256: sha256Schema,
    provider: providerResultSchema.nullable(),
    providerFailure: providerFailureSchema.nullable(),
    failure: orchestrationFailureSchema.nullable(),
    patch: patchRecordSchema.nullable(),
    approvalSha256: sha256Schema.nullable(),
    verificationReceiptPath: absolutePathSchema.nullable(),
    verificationReceiptSha256: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.frozenFoundation.baseCommit !== value.baseCommit ||
      value.frozenFoundation.baseTree !== value.baseTree
    ) {
      context.addIssue({
        code: 'custom',
        path: ['frozenFoundation'],
        message: 'Frozen foundation must bind the exact retained base commit and tree.',
      });
    }
    const expectedFiles = {
      lifecyclePath: path.join(value.artifactDirectory, 'lifecycle.json'),
      patchPath: path.join(value.artifactDirectory, 'candidate.patch'),
      approvalPath: path.join(value.artifactDirectory, 'human-decision.json'),
    } as const;
    for (const [field, expected] of Object.entries(expectedFiles)) {
      if (value[field as keyof typeof expectedFiles] !== expected) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must use its canonical artifact location.`,
        });
      }
    }
    if (path.dirname(value.artifactDirectory) !== path.join(value.projectRoot, 'test-results', 'repair-runs')) {
      context.addIssue({
        code: 'custom',
        path: ['artifactDirectory'],
        message: 'Artifact directory is outside the PromiseProof repair root.',
      });
    }
    if (path.basename(value.artifactDirectory) !== value.repairId) {
      context.addIssue({
        code: 'custom',
        path: ['artifactDirectory'],
        message: 'Artifact directory must be named with the repair ID.',
      });
    }
    const candidateTempRoot = path.dirname(value.candidateWorktreePath);
    if (
      path.basename(value.candidateWorktreePath) !== 'checkout' ||
      value.codexHomePath !== path.join(candidateTempRoot, 'codex-home') ||
      value.toolTempPath !== path.join(candidateTempRoot, 'tool-temp')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['candidateWorktreePath'],
        message: 'Candidate and isolated Codex paths do not share the canonical temp root.',
      });
    }
    if (
      value.verificationReceiptPath !== null &&
      ![
        path.join(
          value.artifactDirectory,
          'verification',
          'verification-receipt.json',
        ),
        path.join(
          value.artifactDirectory,
          'verification',
          'verification-failure.json',
        ),
      ].includes(value.verificationReceiptPath)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verificationReceiptPath'],
        message: 'Verification receipt path is outside its canonical artifact location.',
      });
    }
    const isPassingReceipt =
      value.verificationReceiptPath ===
      path.join(
        value.artifactDirectory,
        'verification',
        'verification-receipt.json',
      );
    if (
      (isPassingReceipt && value.verificationReceiptSha256 === null) ||
      (!isPassingReceipt && value.verificationReceiptSha256 !== null)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['verificationReceiptSha256'],
        message: 'Only a canonical passing receipt may retain an exact receipt digest.',
      });
    }
    if (value.provider !== null && value.providerFailure !== null) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'A repair cannot retain both a provider result and provider failure.',
      });
    }
    if (
      !['created', 'baseline_verified'].includes(value.state) &&
      value.failure === null &&
      value.provider === null
    ) {
      context.addIssue({
        code: 'custom',
        path: ['provider'],
        message: 'A successful completed preparation requires a provider result.',
      });
    }
    const patchRequired =
      value.failure === null &&
      !['created', 'baseline_verified', 'codex_completed'].includes(value.state);
    if (patchRequired && value.patch === null) {
      context.addIssue({
        code: 'custom',
        path: ['patch'],
        message: 'This repair state requires a retained validated patch.',
      });
    }
  });
const lifecycleEventBaseSchema = z
  .object({
    sequence: z.number().int().positive(),
    repairId: z.string().uuid(),
    state: z.enum(REPAIR_STATES),
    recordedAt: z.string().datetime(),
    previousEventSha256: z.string().regex(SHA256).nullable(),
    payloadSha256: z.string().regex(SHA256),
  })
  .strict();

const lifecycleEventSchema = lifecycleEventBaseSchema
  .extend({ eventSha256: z.string().regex(SHA256) })
  .strict();

const lifecycleSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_LIFECYCLE_VERSION),
    repairId: z.string().uuid(),
    events: z.array(lifecycleEventSchema).min(1),
  })
  .strict();

export function sha256Bytes(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicReplace(filePath: string, body: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function writeNewJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  await writeNewBytes(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeNewBytes(
  filePath: string,
  value: string | Buffer,
): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export async function writeLocalRepairState(
  filePath: string,
  state: LocalRepairStateV1,
): Promise<void> {
  const parsed = localRepairStateSchema.parse(state);
  await atomicReplace(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

export async function readLocalRepairState(
  filePath: string,
): Promise<LocalRepairStateV1> {
  try {
    return deepFreeze(
      localRepairStateSchema.parse(
        JSON.parse(await readFile(filePath, 'utf8')) as unknown,
      ),
    );
  } catch (error) {
    throw new Error(
      'PP_REPAIR_LOCAL_STATE_INVALID: local state is malformed.',
      { cause: error },
    );
  }
}

function eventBase(
  repairId: string,
  sequence: number,
  state: RepairStateName,
  previousEventSha256: string | null,
  payload: unknown,
): z.infer<typeof lifecycleEventBaseSchema> {
  return lifecycleEventBaseSchema.parse({
    sequence,
    repairId,
    state,
    recordedAt: new Date().toISOString(),
    previousEventSha256,
    payloadSha256: sha256CanonicalJson(payload),
  });
}

export function validateRepairLifecycle(value: unknown): RepairLifecycleV1 {
  const parsed = lifecycleSchema.parse(value);
  let previous: string | null = null;
  for (let index = 0; index < parsed.events.length; index += 1) {
    const event = parsed.events[index]!;
    if (
      event.repairId !== parsed.repairId ||
      event.sequence !== index + 1 ||
      event.previousEventSha256 !== previous
    ) {
      throw new Error('PP_REPAIR_LIFECYCLE_INVALID: lifecycle chain is broken.');
    }
    const { eventSha256: _eventSha256, ...base } = event;
    const expected = sha256CanonicalJson(base);
    if (event.eventSha256 !== expected) {
      throw new Error('PP_REPAIR_LIFECYCLE_INVALID: lifecycle event hash differs.');
    }
    const previousState = parsed.events[index - 1]?.state;
    if (
      (index === 0 && event.state !== 'created') ||
      (previousState !== undefined &&
        !ALLOWED_REPAIR_TRANSITIONS[previousState].includes(event.state))
    ) {
      throw new Error(
        'PP_REPAIR_LIFECYCLE_INVALID: lifecycle state transition is not allowed.',
      );
    }
    previous = event.eventSha256;
  }
  return deepFreeze(parsed);
}

export async function readRepairLifecycle(
  filePath: string,
): Promise<RepairLifecycleV1> {
  try {
    return validateRepairLifecycle(
      JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    );
  } catch (error) {
    throw new Error(
      'PP_REPAIR_LIFECYCLE_INVALID: retained lifecycle is malformed.',
      { cause: error },
    );
  }
}

export async function appendRepairLifecycle(
  filePath: string,
  repairId: string,
  state: RepairStateName,
  payload: unknown,
): Promise<RepairLifecycleV1> {
  let existing: RepairLifecycleV1 | null = null;
  try {
    existing = validateRepairLifecycle(
      JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    );
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      )
    ) {
      throw error;
    }
  }
  if (existing !== null && existing.repairId !== repairId) {
    throw new Error('PP_REPAIR_LIFECYCLE_INVALID: repair ID changed.');
  }
  const previous = existing?.events.at(-1)?.eventSha256 ?? null;
  const base = eventBase(
    repairId,
    (existing?.events.length ?? 0) + 1,
    state,
    previous,
    payload,
  );
  const event: RepairLifecycleEventV1 = {
    ...base,
    eventSha256: sha256CanonicalJson(base),
  };
  const lifecycle: RepairLifecycleV1 = {
    schemaVersion: REPAIR_LIFECYCLE_VERSION,
    repairId,
    events: [...(existing?.events ?? []), event],
  };
  validateRepairLifecycle(lifecycle);
  await atomicReplace(filePath, `${JSON.stringify(lifecycle, null, 2)}\n`);
  return deepFreeze(lifecycle);
}

export async function fileSha256(filePath: string): Promise<string> {
  return sha256Bytes(await readFile(filePath));
}

export function canonicalStateSha256(state: LocalRepairStateV1): string {
  return sha256Bytes(canonicalJson(state));
}
