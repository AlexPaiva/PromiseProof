import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';

import { z } from 'zod';

import { deepFreeze } from '../investigation/immutable.js';
import {
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  readRepairLifecycle,
  writeLocalRepairState,
  writeNewJson,
} from './artifact.js';

export const REPAIR_APPROVAL_VERSION =
  'promiseproof.human-repair-decision.v1' as const;

export const humanRepairDecisionSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_APPROVAL_VERSION),
    repairId: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    patchSha256: z.string().regex(/^[a-f0-9]{64}$/),
    patchBytes: z.number().int().positive().max(32 * 1024),
    decidedAt: z.string().datetime(),
    reviewer: z.literal('human_operator'),
    method: z.literal('interactive_tty_exact_phrase'),
    confirmationSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedConfirmation = expectedReviewPhrase(
      value.decision === 'approved' ? 'APPROVE' : 'REJECT',
      value.repairId,
      value.patchSha256,
    );
    if (value.confirmationSha256 !== digest(expectedConfirmation)) {
      context.addIssue({
        code: 'custom',
        path: ['confirmationSha256'],
        message: 'Confirmation digest does not bind the exact review phrase.',
      });
    }
  });

export type HumanRepairDecisionV1 = z.infer<typeof humanRepairDecisionSchema>;

const REVIEW_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const REVIEW_UNSAFE_CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BARE_CARRIAGE_RETURN = /\r(?!\n)/u;
const EXPECTED_DIFF_HEADERS = [
  'diff --git a/src/client/main.ts b/src/client/main.ts',
  'diff --git a/tests/regression/initialization-order.spec.ts b/tests/regression/initialization-order.spec.ts',
] as const;

export function expectedReviewPhrase(
  decision: 'APPROVE' | 'REJECT',
  repairId: string,
  patchSha256: string,
): string {
  return `${decision} ${repairId} ${patchSha256}`;
}

export function parseReviewPhrase(
  value: string,
  repairId: string,
  patchSha256: string,
): 'approved' | 'rejected' {
  if (value === expectedReviewPhrase('APPROVE', repairId, patchSha256)) {
    return 'approved';
  }
  if (value === expectedReviewPhrase('REJECT', repairId, patchSha256)) {
    return 'rejected';
  }
  throw new Error(
    'PP_REPAIR_REVIEW_PHRASE_INVALID: the full repair ID and patch digest are required.',
  );
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function reviewCandidateInteractively(input: {
  statePath: string;
  stdin?: Readable;
  stdout?: Writable;
}): Promise<HumanRepairDecisionV1> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  if (stdin !== process.stdin || stdout !== process.stdout) {
    throw new Error(
      'PP_REPAIR_REVIEW_IO_INVALID: production review cannot inject alternate streams.',
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'PP_REPAIR_REVIEW_TTY_REQUIRED: approval or rejection requires a human interactive terminal.',
    );
  }

  const retainedState = await readLocalRepairState(input.statePath);
  const canonicalStatePath = path.join(
    retainedState.artifactDirectory,
    'state.json',
  );
  if (path.resolve(input.statePath) !== canonicalStatePath) {
    throw new Error(
      'PP_REPAIR_REVIEW_STATE_PATH_INVALID: state file is outside its canonical repair directory.',
    );
  }
  if (
    (await lstat(retainedState.artifactDirectory)).isSymbolicLink() ||
    !(await lstat(retainedState.artifactDirectory)).isDirectory()
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_ARTIFACT_PATH_INVALID: repair artifacts must use a real directory.',
    );
  }
  if (
    ![
      'awaiting_human_review',
      'human_approved',
      'human_rejected',
    ].includes(retainedState.state) || retainedState.patch === null
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_STATE_INVALID: candidate is not awaiting human review.',
    );
  }
  const patchInfo = await lstat(retainedState.patchPath);
  if (
    patchInfo.isSymbolicLink() ||
    !patchInfo.isFile() ||
    patchInfo.nlink !== 1
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_PATCH_PATH_INVALID: retained patch must be a regular file.',
    );
  }
  const patchRecord = retainedState.patch;
  const state = structuredClone(retainedState);
  const patchBytes = await readFile(state.patchPath);
  let patch: string;
  try {
    patch = REVIEW_TEXT_DECODER.decode(patchBytes);
  } catch (error) {
    throw new Error(
      'PP_REPAIR_REVIEW_PATCH_TEXT_INVALID: retained patch is not valid UTF-8.',
      { cause: error },
    );
  }
  const diffHeaders = patch
    .split('\n')
    .filter((line) => line.startsWith('diff --git '));
  if (
    REVIEW_UNSAFE_CONTROL.test(patch) ||
    BARE_CARRIAGE_RETURN.test(patch) ||
    diffHeaders.length !== EXPECTED_DIFF_HEADERS.length ||
    diffHeaders.some((header, index) => header !== EXPECTED_DIFF_HEADERS[index]) ||
    /(?:GIT binary patch|Binary files .* differ|^old mode |^deleted file mode |^rename from |^rename to )/mu.test(
      patch,
    )
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_PATCH_TEXT_INVALID: retained patch is unsafe to display or has unexpected structure.',
    );
  }
  const currentPatchSha256 = createHash('sha256')
    .update(patchBytes)
    .digest('hex');
  if (
    currentPatchSha256 !== patchRecord.sha256 ||
    patchBytes.byteLength !== patchRecord.bytes
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_PATCH_CHANGED: retained patch differs from the candidate record.',
    );
  }

  let existingDecision: HumanRepairDecisionV1 | null = null;
  try {
    const approvalInfo = await lstat(state.approvalPath);
    if (
      approvalInfo.isSymbolicLink() ||
      !approvalInfo.isFile() ||
      approvalInfo.nlink !== 1
    ) {
      throw new Error(
        'PP_REPAIR_REVIEW_APPROVAL_PATH_INVALID: retained decision must be a regular file.',
      );
    }
    existingDecision = await readHumanDecision(state.approvalPath);
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

  const lifecycle = await readRepairLifecycle(state.lifecyclePath);
  const lifecycleHead = lifecycle.events.at(-1)?.state;
  if (existingDecision !== null) {
    const decisionState =
      existingDecision.decision === 'approved'
        ? 'human_approved'
        : 'human_rejected';
    if (
      existingDecision.repairId !== state.repairId ||
      existingDecision.patchSha256 !== patchRecord.sha256 ||
      existingDecision.patchBytes !== patchRecord.bytes ||
      !['awaiting_human_review', decisionState].includes(state.state)
    ) {
      throw new Error(
        'PP_REPAIR_REVIEW_DECISION_CHANGED: retained decision does not match this candidate.',
      );
    }
    if (lifecycleHead === 'awaiting_human_review') {
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        decisionState,
        existingDecision,
      );
    } else if (
      lifecycleHead !== decisionState &&
      !(
        decisionState === 'human_rejected' &&
        ['evidence_saved', 'cleanup_failed', 'cleanup_completed'].includes(
          lifecycleHead ?? '',
        )
      )
    ) {
      throw new Error(
        'PP_REPAIR_REVIEW_LIFECYCLE_INVALID: retained decision and lifecycle disagree.',
      );
    }
    if (lifecycleHead === 'awaiting_human_review' || lifecycleHead === decisionState) {
      state.state = decisionState;
      state.updatedAt = new Date().toISOString();
      state.approvalSha256 = await fileSha256(state.approvalPath);
      await writeLocalRepairState(input.statePath, state);
    }
    return deepFreeze(existingDecision);
  }
  if (
    state.state !== 'awaiting_human_review' ||
    lifecycleHead !== 'awaiting_human_review'
  ) {
    throw new Error(
      'PP_REPAIR_REVIEW_DECISION_MISSING: a persisted decision state has no matching decision artifact.',
    );
  }

  stdout.write('\n=== PromiseProof candidate patch (complete) ===\n\n');
  stdout.write(patch);
  if (!patch.endsWith('\n')) {
    stdout.write('\n');
  }
  stdout.write('\n=== Human decision boundary ===\n');
  stdout.write(`Repair ID: ${state.repairId}\n`);
  stdout.write(`Patch SHA-256: ${patchRecord.sha256}\n`);
  stdout.write(`Patch bytes: ${patchRecord.bytes}\n`);
  stdout.write(
    `To approve, type exactly:\n${expectedReviewPhrase('APPROVE', state.repairId, patchRecord.sha256)}\n`,
  );
  stdout.write(
    `To reject, type exactly:\n${expectedReviewPhrase('REJECT', state.repairId, patchRecord.sha256)}\n\n`,
  );

  const readline = createInterface({ input: stdin, output: stdout });
  let confirmation: string;
  try {
    confirmation = await readline.question('Decision: ');
  } finally {
    readline.close();
  }
  const decision = parseReviewPhrase(
    confirmation,
    state.repairId,
    patchRecord.sha256,
  );
  const record = humanRepairDecisionSchema.parse({
    schemaVersion: REPAIR_APPROVAL_VERSION,
    repairId: state.repairId,
    decision,
    patchSha256: patchRecord.sha256,
    patchBytes: patchRecord.bytes,
    decidedAt: new Date().toISOString(),
    reviewer: 'human_operator',
    method: 'interactive_tty_exact_phrase',
    confirmationSha256: digest(confirmation),
  });
  await writeNewJson(state.approvalPath, record);
  await appendRepairLifecycle(
    state.lifecyclePath,
    state.repairId,
    decision === 'approved' ? 'human_approved' : 'human_rejected',
    record,
  );
  state.state = decision === 'approved' ? 'human_approved' : 'human_rejected';
  state.updatedAt = new Date().toISOString();
  state.approvalSha256 = await fileSha256(state.approvalPath);
  await writeLocalRepairState(input.statePath, state);
  return deepFreeze(record);
}

export async function readHumanDecision(
  approvalPath: string,
): Promise<HumanRepairDecisionV1> {
  return deepFreeze(
    humanRepairDecisionSchema.parse(
      JSON.parse(await readFile(approvalPath, 'utf8')) as unknown,
    ),
  );
}
