import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { deepFreeze } from '../investigation/immutable.js';
import {
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  readRepairLifecycle,
  writeLocalRepairState,
  writeNewJson,
  type LocalRepairStateV1,
  type RepairStateName,
} from './artifact.js';
import {
  readHumanDecision,
  reviewCandidateInteractively,
  type HumanRepairDecisionV1,
} from './approval.js';
import {
  equalRefStates,
  resolveCleanRepository,
  runGit,
} from './git.js';
import {
  acquireRepairLock,
  allocateLoopbackPort,
  resolveRepairRunsRoot,
} from './runner.js';
import {
  buildArtifactManifest,
  RepairVerificationError,
  verifyApprovedRepair,
  type BoundedCommandRunner,
  type RepairVerificationReceiptV1,
} from './verification.js';
import {
  cleanupDisposableWorktree,
  cleanupPersistedDisposableWorktreeIntent,
  materializeDisposableWorktree,
  planDisposableWorktree,
  repairWorktreeAllocationId,
  reopenDisposableWorktree,
  type DisposableWorktree,
} from './worktree.js';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HumanReviewResult {
  readonly decision: HumanRepairDecisionV1;
  readonly statePath: string;
  readonly state: 'human_approved' | 'cleanup_completed' | 'cleanup_failed';
}

export interface RepairVerificationResult {
  readonly statePath: string;
  readonly receiptPath: string;
  readonly receipt: RepairVerificationReceiptV1;
  readonly cleanupState: 'cleanup_completed' | 'cleanup_failed';
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

function stateFailure(
  stage: string,
  error: unknown,
  code = 'PP_REPAIR_VERIFICATION_FAILED',
): NonNullable<LocalRepairStateV1['failure']> {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    stage,
    code,
    message: detail.slice(0, 1_000),
    recordedAt: new Date().toISOString(),
  };
}

function parseRetainedFailure(value: unknown): NonNullable<LocalRepairStateV1['failure']> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'code,message,recordedAt,stage'
  ) {
    throw new Error(
      'PP_REPAIR_FAILURE_EVIDENCE_INVALID: retained preparation failure has unexpected fields.',
    );
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.stage !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(record.stage) ||
    typeof record.code !== 'string' ||
    !/^PP_[A-Z0-9_]+$/u.test(record.code) ||
    typeof record.message !== 'string' ||
    record.message.length === 0 ||
    record.message.length > 1_000 ||
    typeof record.recordedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.recordedAt))
  ) {
    throw new Error(
      'PP_REPAIR_FAILURE_EVIDENCE_INVALID: retained preparation failure is malformed.',
    );
  }
  return record as unknown as NonNullable<LocalRepairStateV1['failure']>;
}

async function retainInterruptedPreparation(
  statePath: string,
  state: LocalRepairStateV1,
  priorHead: Extract<
    RepairStateName,
    'created' | 'baseline_verified' | 'codex_completed' | 'candidate_policy_accepted'
  >,
): Promise<void> {
  const failurePath = path.join(state.artifactDirectory, 'failure.json');
  let failure = state.failure;
  if (await pathExists(failurePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(failurePath, 'utf8')) as unknown;
    } catch (error) {
      throw new Error(
        'PP_REPAIR_FAILURE_EVIDENCE_INVALID: retained preparation failure is not valid JSON.',
        { cause: error },
      );
    }
    const retained = parseRetainedFailure(parsed);
    if (failure !== null && JSON.stringify(failure) !== JSON.stringify(retained)) {
      throw new Error(
        'PP_REPAIR_FAILURE_EVIDENCE_INVALID: retained failure differs from local state.',
      );
    }
    failure = retained;
  } else {
    failure ??= stateFailure(
      'preparation_interrupted',
      new Error(
        `Repair preparation stopped while lifecycle state was ${priorHead}.`,
      ),
      'PP_REPAIR_PREPARATION_FAILED',
    );
    await writeNewJson(failurePath, failure);
  }
  state.failure = failure;
  await appendRepairLifecycle(
    state.lifecyclePath,
    state.repairId,
    'evidence_saved',
    {
      failure,
      recovery: 'interrupted_preparation',
      priorLifecycleState: priorHead,
    },
  );
  state.state = 'evidence_saved';
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
}

export async function resolveRepairStatePath(
  projectRoot: string,
  repairId: string,
): Promise<string> {
  if (!UUID.test(repairId)) {
    throw new Error('PP_REPAIR_ID_INVALID: repair ID must be a UUID.');
  }
  const root = await resolveRepairRunsRoot(projectRoot);
  return path.join(root, repairId, 'state.json');
}

export async function readBoundRepairState(
  projectRoot: string,
  repairId: string,
): Promise<{
  readonly statePath: string;
  readonly state: LocalRepairStateV1;
}> {
  const repository = await resolveCleanRepository(projectRoot);
  const statePath = await resolveRepairStatePath(repository.repoRoot, repairId);
  const [info, resolvedStatePath] = await Promise.all([
    lstat(statePath),
    realpath(statePath),
  ]);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1 ||
    !sameFilesystemPath(resolvedStatePath, statePath)
  ) {
    throw new Error(
      'PP_REPAIR_STATE_PATH_INVALID: repair state must be one real file at its canonical path.',
    );
  }
  const state = await readLocalRepairState(statePath);
  const expectedArtifactDirectory = path.join(
    repository.repoRoot,
    'test-results',
    'repair-runs',
    repairId,
  );
  const candidateAllocationRoot = `repair-${repairWorktreeAllocationId(
    repairId,
    'candidate',
  )}`;
  const verificationAllocationRoot = `repair-${repairWorktreeAllocationId(
    repairId,
    'verification',
  )}`;
  if (
    state.repairId !== repairId ||
    !sameFilesystemPath(state.projectRoot, repository.repoRoot) ||
    !sameFilesystemPath(state.artifactDirectory, expectedArtifactDirectory) ||
    !sameFilesystemPath(path.dirname(statePath), expectedArtifactDirectory) ||
    path.basename(path.dirname(state.candidateWorktreePath)) !==
      candidateAllocationRoot ||
    (state.verificationWorktreePath !== null &&
      path.basename(path.dirname(state.verificationWorktreePath)) !==
        verificationAllocationRoot)
  ) {
    throw new Error(
      'PP_REPAIR_STATE_BINDING_INVALID: retained state is not bound to the requested repository and repair ID.',
    );
  }
  return deepFreeze({ statePath, state });
}

async function cleanupCandidate(
  state: LocalRepairStateV1,
): Promise<void> {
  if (!(await pathExists(state.candidateWorktreePath))) {
    await cleanupPersistedDisposableWorktreeIntent(
      state.projectRoot,
      state.candidateWorktreePath,
    );
    return;
  }
  const candidate = await reopenDisposableWorktree(
    state.projectRoot,
    state.candidateWorktreePath,
  );
  if (candidate.repository.baseHead !== state.baseCommit) {
    throw new Error(
      'PP_REPAIR_CLEANUP_BASE_CHANGED: candidate worktree base differs from retained state.',
    );
  }
  await cleanupDisposableWorktree(candidate);
  await assertWorktreeUnregistered(state, state.candidateWorktreePath);
}

function sameFilesystemPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function assertWorktreeUnregistered(
  state: LocalRepairStateV1,
  worktreePath: string,
): Promise<void> {
  const listing = (
    await runGit(state.projectRoot, ['worktree', 'list', '--porcelain', '-z'])
  ).stdout;
  const registeredPaths = listing
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
  if (
    registeredPaths.some((registered) =>
      sameFilesystemPath(registered, worktreePath),
    )
  ) {
    throw new Error(
      'PP_REPAIR_CLEANUP_REGISTRATION_RETAINED: Git still registers a disposable worktree whose checkout is missing.',
    );
  }
}

async function lifecycleHead(
  state: LocalRepairStateV1,
): Promise<RepairStateName> {
  const lifecycle = await readRepairLifecycle(state.lifecyclePath);
  if (lifecycle.repairId !== state.repairId) {
    throw new Error(
      'PP_REPAIR_LIFECYCLE_INVALID: lifecycle names a different repair.',
    );
  }
  const head = lifecycle.events.at(-1)?.state;
  if (head === undefined) {
    throw new Error('PP_REPAIR_LIFECYCLE_INVALID: lifecycle is empty.');
  }
  return head;
}

async function cleanupVerificationWorktree(
  state: LocalRepairStateV1,
  activeHandle: DisposableWorktree | null = null,
): Promise<void> {
  const verificationPath = state.verificationWorktreePath;
  if (verificationPath === null) {
    return;
  }
  if (!(await pathExists(verificationPath))) {
    await cleanupPersistedDisposableWorktreeIntent(
      state.projectRoot,
      verificationPath,
    );
    return;
  }
  const handle =
    activeHandle !== null &&
    path.resolve(activeHandle.worktreePath) === path.resolve(verificationPath)
      ? activeHandle
      : await reopenDisposableWorktree(state.projectRoot, verificationPath);
  if (handle.repository.baseHead !== state.baseCommit) {
    throw new Error(
      'PP_REPAIR_CLEANUP_BASE_CHANGED: verification worktree base differs from retained state.',
    );
  }
  await cleanupDisposableWorktree(handle);
  await assertWorktreeUnregistered(state, verificationPath);
}

async function recordCleanup(
  statePath: string,
  state: LocalRepairStateV1,
  cleanup: () => Promise<void>,
  verificationExpected: boolean,
): Promise<'cleanup_completed' | 'cleanup_failed'> {
  const retainedHead = await lifecycleHead(state);
  if (retainedHead === 'cleanup_completed') {
    state.state = 'cleanup_completed';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    return 'cleanup_completed';
  }
  try {
    await cleanup();
    const headAfterCleanup = await lifecycleHead(state);
    if (headAfterCleanup !== 'cleanup_completed') {
      if (
        headAfterCleanup !== 'evidence_saved' &&
        headAfterCleanup !== 'cleanup_failed'
      ) {
        throw new Error(
          'PP_REPAIR_CLEANUP_STATE_INVALID: lifecycle is not ready for cleanup.',
        );
      }
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'cleanup_completed',
        {
          candidateRemoved: true,
          verificationRemoved: verificationExpected,
        },
      );
    }
    state.state = 'cleanup_completed';
  } catch (error) {
    const headAfterFailure = await lifecycleHead(state);
    if (headAfterFailure === 'cleanup_completed') {
      state.state = 'cleanup_completed';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
      return 'cleanup_completed';
    }
    const failure = stateFailure('cleanup', error);
    if (headAfterFailure !== 'cleanup_failed') {
      if (headAfterFailure !== 'evidence_saved') {
        throw error;
      }
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'cleanup_failed',
        failure,
      );
    }
    state.failure = failure;
    state.state = 'cleanup_failed';
  }
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
  return state.state as 'cleanup_completed' | 'cleanup_failed';
}

export async function reviewRaceRepairInteractively(
  projectRoot: string,
  repairId: string,
): Promise<HumanReviewResult> {
  const lock = await acquireRepairLock(projectRoot);
  try {
    const { statePath } = await readBoundRepairState(projectRoot, repairId);
    const decision = await reviewCandidateInteractively({ statePath });
    if (decision.decision === 'approved') {
      return deepFreeze({
        decision,
        statePath,
        state: 'human_approved' as const,
      });
    }

    const state = structuredClone(
      (await readBoundRepairState(projectRoot, repairId)).state,
    );
    let rejectedHead = await lifecycleHead(state);
    if (
      state.state !== 'human_rejected' &&
      !['evidence_saved', 'cleanup_failed', 'cleanup_completed'].includes(
        rejectedHead,
      )
    ) {
      throw new Error(
        'PP_REPAIR_REVIEW_STATE_INVALID: rejected decision was not persisted.',
      );
    }
    if (rejectedHead === 'human_rejected') {
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'evidence_saved',
        {
          decision: 'rejected',
          patchSha256: decision.patchSha256,
          approvalSha256: state.approvalSha256,
        },
      );
      rejectedHead = 'evidence_saved';
    }
    if (rejectedHead === 'evidence_saved') {
      state.state = 'evidence_saved';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
    } else if (rejectedHead === 'cleanup_failed') {
      state.state = 'cleanup_failed';
    } else if (rejectedHead === 'cleanup_completed') {
      state.state = 'cleanup_completed';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
      return deepFreeze({ decision, statePath, state: 'cleanup_completed' });
    }
    const cleanupState = await recordCleanup(
      statePath,
      state,
      () => cleanupCandidate(state),
      false,
    );
    return deepFreeze({ decision, statePath, state: cleanupState });
  } finally {
    await lock.release();
  }
}

async function assertRetainedApproval(
  state: LocalRepairStateV1,
): Promise<HumanRepairDecisionV1> {
  if (
    state.state !== 'human_approved' ||
    state.patch === null ||
    state.approvalSha256 === null
  ) {
    throw new Error(
      'PP_REPAIR_NOT_APPROVED: repair must have an exact retained human approval.',
    );
  }
  const [approval, approvalSha256, patchSha256] = await Promise.all([
    readHumanDecision(state.approvalPath),
    fileSha256(state.approvalPath),
    fileSha256(state.patchPath),
  ]);
  if (
    approval.decision !== 'approved' ||
    approval.repairId !== state.repairId ||
    approval.patchSha256 !== state.patch.sha256 ||
    approval.patchBytes !== state.patch.bytes ||
    approvalSha256 !== state.approvalSha256 ||
    patchSha256 !== state.patch.sha256
  ) {
    throw new Error(
      'PP_REPAIR_APPROVAL_CHANGED: approval or patch no longer matches retained state.',
    );
  }
  return approval;
}

async function assertUnchangedBase(state: LocalRepairStateV1): Promise<void> {
  const repository = await resolveCleanRepository(state.projectRoot);
  if (
    repository.baseHead !== state.baseCommit ||
    repository.headRef !== state.baseHeadRef ||
    !equalRefStates(repository.refState, state.baseRefState)
  ) {
    throw new Error(
      'PP_REPAIR_BASE_CHANGED: main checkout or Git refs changed after candidate preparation.',
    );
  }
}

async function retainedPassingReceipt(state: LocalRepairStateV1): Promise<{
  readonly path: string;
  readonly sha256: string;
}> {
  if (state.patch === null) {
    throw new Error('PP_REPAIR_PASS_RECEIPT_INVALID: retained patch is missing.');
  }
  const receiptPath = path.join(
    state.artifactDirectory,
    'verification',
    'verification-receipt.json',
  );
  if (
    state.verificationReceiptPath !== receiptPath ||
    state.verificationReceiptSha256 === null
  ) {
    throw new Error(
      'PP_REPAIR_PASS_RECEIPT_INVALID: retained state does not anchor the canonical pass receipt and digest.',
    );
  }
  const info = await lstat(receiptPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    throw new Error(
      'PP_REPAIR_PASS_RECEIPT_INVALID: pass receipt must be one regular file.',
    );
  }
  const receiptBytes = await readFile(receiptPath);
  const receiptSha256 = await fileSha256(receiptPath);
  if (receiptSha256 !== state.verificationReceiptSha256) {
    throw new Error(
      'PP_REPAIR_PASS_RECEIPT_INVALID: retained pass receipt digest changed after verification.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(receiptBytes.toString('utf8')) as unknown;
  } catch (error) {
    throw new Error('PP_REPAIR_PASS_RECEIPT_INVALID: pass receipt is malformed.', {
      cause: error,
    });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('PP_REPAIR_PASS_RECEIPT_INVALID: pass receipt is not an object.');
  }
  const receipt = value as Record<string, unknown>;
  const checks = receipt.checks;
  const expectedStageIds = [
    'install_dependencies',
    'build',
    'race_off_single',
    'race_on_single',
    'race_off_repeat_5',
    'race_on_repeat_5',
    'propagation_expected_red',
    'propagation_green',
    'startup_regression',
  ];
  const commands = Array.isArray(receipt.commands) ? receipt.commands : [];
  const stageIds = commands.map((command) =>
    typeof command === 'object' && command !== null && 'id' in command
      ? (command as { id?: unknown }).id
      : null,
  );
  if (
    receipt.schemaVersion !== 'promiseproof.repair-verification.v1' ||
    receipt.repairId !== state.repairId ||
    receipt.verdict !== 'pass' ||
    receipt.baseCommit !== state.baseCommit ||
    receipt.approvedPatchSha256 !== state.patch.sha256 ||
    receipt.patchBytes !== state.patch.bytes ||
    receipt.verificationWorktreeFresh !== true ||
    receipt.candidateAndVerificationWorktreesDistinct !== true ||
    receipt.patchAppliedByExactDigest !== true ||
    receipt.patchUnchangedAfterVerification !== true ||
    JSON.stringify(stageIds) !== JSON.stringify(expectedStageIds) ||
    typeof checks !== 'object' ||
    checks === null ||
    Array.isArray(checks) ||
    (checks as Record<string, unknown>).build !== true ||
    !Array.isArray((checks as Record<string, unknown>).raceOffFive) ||
    ((checks as Record<string, unknown>).raceOffFive as unknown[]).length !== 5 ||
    !Array.isArray((checks as Record<string, unknown>).raceOnFive) ||
    ((checks as Record<string, unknown>).raceOnFive as unknown[]).length !== 5 ||
    (checks as Record<string, unknown>).propagationGreenTestCount !== 6 ||
    (checks as Record<string, unknown>).startupRegressionTestCount !== 1 ||
    (await fileSha256(state.patchPath)) !== state.patch.sha256
  ) {
    throw new Error(
      'PP_REPAIR_PASS_RECEIPT_INVALID: retained pass receipt no longer matches the approved repair and exact check sequence.',
    );
  }
  const currentManifest = (await buildArtifactManifest(path.dirname(receiptPath)))
    .filter((entry) => entry.path !== 'verification-receipt.json');
  if (
    !Array.isArray(receipt.retainedArtifacts) ||
    JSON.stringify(receipt.retainedArtifacts) !== JSON.stringify(currentManifest)
  ) {
    throw new Error(
      'PP_REPAIR_PASS_RECEIPT_INVALID: retained artifact manifest no longer matches verification evidence.',
    );
  }
  return { path: receiptPath, sha256: state.verificationReceiptSha256 };
}

async function recoverInterruptedVerification(
  projectRoot: string,
  repairId: string,
  cause: unknown,
  activeVerification: DisposableWorktree | null = null,
): Promise<
  'not_started' | 'prestart_cleaned' | 'recovered' | 'recovered_pass'
> {
  const bound = await readBoundRepairState(projectRoot, repairId);
  const statePath = bound.statePath;
  const state = structuredClone(bound.state);
  let head = await lifecycleHead(state);

  if (head === 'human_approved') {
    if (
      activeVerification !== null &&
      state.verificationWorktreePath !== null &&
      !sameFilesystemPath(
        activeVerification.worktreePath,
        state.verificationWorktreePath,
      )
    ) {
      throw new Error(
        'PP_REPAIR_VERIFICATION_PATH_CHANGED: active and retained verification worktrees differ.',
      );
    }
    if (
      activeVerification !== null ||
      state.verificationWorktreePath !== null
    ) {
      if (activeVerification !== null && state.verificationWorktreePath === null) {
        if (activeVerification.repository.baseHead !== state.baseCommit) {
          throw new Error(
            'PP_REPAIR_CLEANUP_BASE_CHANGED: active verification worktree base differs from retained state.',
          );
        }
        await cleanupDisposableWorktree(activeVerification);
        await assertWorktreeUnregistered(state, activeVerification.worktreePath);
      } else {
        await cleanupVerificationWorktree(state, activeVerification);
      }
      state.verificationWorktreePath = null;
      state.state = 'human_approved';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
      return 'prestart_cleaned';
    }
    return 'not_started';
  }

  if (
    ![
      'verification_started',
      'verification_passed',
      'verification_failed',
      'evidence_saved',
      'cleanup_failed',
      'cleanup_completed',
    ].includes(head)
  ) {
    return 'not_started';
  }

  if (head === 'cleanup_completed') {
    const passWasRetained =
      state.verificationReceiptPath !== null &&
      state.verificationReceiptPath.endsWith('verification-receipt.json') &&
      (await pathExists(state.verificationReceiptPath));
    if (passWasRetained) {
      await retainedPassingReceipt(state);
    }
    state.state = 'cleanup_completed';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    return passWasRetained ? 'recovered_pass' : 'recovered';
  }

  let passingReceipt: Awaited<ReturnType<typeof retainedPassingReceipt>> | null =
    null;
  const passingReceiptPath = path.join(
    state.artifactDirectory,
    'verification',
    'verification-receipt.json',
  );
  if (
    [
      'verification_started',
      'verification_passed',
      'evidence_saved',
      'cleanup_failed',
    ].includes(head) &&
    (await pathExists(passingReceiptPath))
  ) {
    try {
      passingReceipt = await retainedPassingReceipt(state);
      state.verificationReceiptPath = passingReceipt.path;
      state.verificationReceiptSha256 = passingReceipt.sha256;
    } catch (error) {
      if (head === 'verification_passed') {
        state.failure = stateFailure('verification_receipt_recovery', error);
      }
    }
  }

  if (head === 'verification_started' && passingReceipt !== null) {
    state.failure = null;
  } else if (head === 'verification_started' || head === 'verification_failed') {
    state.failure ??= stateFailure('verification_interrupted', cause);
    if (cause instanceof RepairVerificationError) {
      state.verificationReceiptPath = cause.failureReceiptPath;
      state.verificationReceiptSha256 = null;
    }
  } else if (head === 'verification_passed' && passingReceipt !== null) {
    state.failure = null;
  } else if (head === 'verification_passed' && state.failure === null) {
    state.failure = stateFailure('verification_receipt_recovery', cause);
  } else if (head === 'evidence_saved' && passingReceipt !== null) {
    state.failure = null;
  } else if (head === 'evidence_saved' && state.failure === null) {
    state.failure = stateFailure('verification_interrupted', cause);
  } else if (head === 'cleanup_failed' && state.failure === null) {
    state.failure = stateFailure('cleanup', cause);
  }

  if (head === 'verification_started') {
    if (passingReceipt !== null) {
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'verification_passed',
        {
          verdict: 'pass',
          authority: 'unchanged_playwright_and_deterministic_evaluator',
          receiptSha256: passingReceipt.sha256,
          recovery: 'receipt_persisted_before_lifecycle_transition',
        },
      );
      head = 'verification_passed';
    } else {
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'verification_failed',
        {
          failure: state.failure,
          failureReceiptPath: state.verificationReceiptPath,
          recovery: 'interrupted_process_or_orchestrator',
        },
      );
      head = 'verification_failed';
    }
  }

  if (head === 'verification_passed' || head === 'verification_failed') {
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'evidence_saved',
      {
        recovery: 'interrupted_verification_finalization',
        priorLifecycleState: head,
        receiptPath: state.verificationReceiptPath,
        ...(passingReceipt === null
          ? { failure: state.failure }
          : {
              verdict: 'pass',
              authority: 'unchanged_playwright_and_deterministic_evaluator',
              receiptSha256: passingReceipt.sha256,
            }),
      },
    );
    head = 'evidence_saved';
  }

  if (head === 'evidence_saved') {
    state.state = 'evidence_saved';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
  } else if (head === 'cleanup_failed') {
    state.state = 'cleanup_failed';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
  }

  await recordCleanup(
    statePath,
    state,
    async () => {
      await cleanupVerificationWorktree(state, activeVerification);
      await cleanupCandidate(state);
    },
    true,
  );
  return passingReceipt === null ? 'recovered' : 'recovered_pass';
}

export async function verifyHumanApprovedRaceRepair(input: {
  readonly projectRoot: string;
  readonly repairId: string;
  readonly isolatedPort?: number;
  readonly commandRunner?: BoundedCommandRunner;
}): Promise<RepairVerificationResult> {
  const lock = await acquireRepairLock(input.projectRoot);
  let verification: DisposableWorktree | null = null;
  let statePath: string | null = null;
  try {
    const bound = await readBoundRepairState(input.projectRoot, input.repairId);
    statePath = bound.statePath;
    const state = structuredClone(bound.state);
    const retainedHead = await lifecycleHead(state);
    if (
      [
        'verification_started',
        'verification_passed',
        'verification_failed',
        'evidence_saved',
        'cleanup_failed',
        'cleanup_completed',
      ].includes(retainedHead)
    ) {
      const recovery = await recoverInterruptedVerification(
        input.projectRoot,
        input.repairId,
        new Error(
          'PP_REPAIR_VERIFICATION_INTERRUPTED: a prior verification did not finalize atomically.',
        ),
      );
      if (recovery === 'recovered_pass') {
        throw new Error(
          'PP_REPAIR_VERIFICATION_PASS_RECOVERED: the authoritative deterministic PASS receipt was retained and cleanup completed; inspect status and do not prepare a replacement candidate.',
        );
      }
      throw new Error(
        'PP_REPAIR_VERIFICATION_RECOVERED: interrupted verification was retired and its worktrees were cleaned; prepare a new candidate.',
      );
    }
    if (retainedHead !== 'human_approved') {
      throw new Error(
        'PP_REPAIR_NOT_APPROVED: lifecycle has no retained human approval.',
      );
    }
    if (state.verificationWorktreePath !== null) {
      await recoverInterruptedVerification(
        input.projectRoot,
        input.repairId,
        new Error(
          'PP_REPAIR_VERIFICATION_PRESTART_INTERRUPTED: a fresh worktree was retained before verification began.',
        ),
      );
      Object.assign(
        state,
        (await readBoundRepairState(input.projectRoot, input.repairId)).state,
      );
    }
    await assertUnchangedBase(state);
    const approval = await assertRetainedApproval(state);
    const port = input.isolatedPort ?? (await allocateLoopbackPort());

    const verificationPlan = await planDisposableWorktree(state.projectRoot, {
      allocationId: repairWorktreeAllocationId(
        state.repairId,
        'verification',
      ),
    });
    state.verificationWorktreePath = verificationPlan.worktreePath;
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    verification = await materializeDisposableWorktree(verificationPlan);
    if (verification.repository.baseHead !== state.baseCommit) {
      throw new Error(
        'PP_REPAIR_VERIFICATION_BASE_CHANGED: fresh worktree has the wrong base.',
      );
    }
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'verification_started',
      {
        patchSha256: approval.patchSha256,
        verificationWorktreeFresh: true,
        candidateAndVerificationWorktreesDistinct: true,
        isolatedPort: port,
      },
    );
    state.state = 'verification_started';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    const verificationRoot = path.join(
      state.artifactDirectory,
      'verification',
    );
    const receipt = await verifyApprovedRepair({
      expectedRepairId: state.repairId,
      verificationWorktree: verification,
      candidateWorktreePath: state.candidateWorktreePath,
      retainedPatchPath: state.patchPath,
      expectedPatchBytes: approval.patchBytes,
      expectedBaseCommit: state.baseCommit,
      approval,
      verificationArtifactRoot: verificationRoot,
      isolatedPort: port,
      ...(input.commandRunner === undefined
        ? {}
        : { commandRunner: input.commandRunner }),
    });

    const receiptPath = path.join(
      verificationRoot,
      'verification-receipt.json',
    );
    const receiptSha256 = await fileSha256(receiptPath);
    state.verificationReceiptPath = receiptPath;
    state.verificationReceiptSha256 = receiptSha256;
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'verification_passed',
      {
        verdict: 'pass',
        authority: 'unchanged_playwright_and_deterministic_evaluator',
        receiptSha256,
      },
    );
    state.state = 'verification_passed';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'evidence_saved',
      { receiptPath, receiptSha256 },
    );
    state.state = 'evidence_saved';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    const cleanupState = await recordCleanup(
      statePath,
      state,
      async () => {
        await cleanupVerificationWorktree(state, verification);
        await cleanupCandidate(state);
      },
      true,
    );
    return deepFreeze({
      statePath,
      receiptPath,
      receipt,
      cleanupState,
    });
  } catch (error) {
    if (statePath !== null) {
      try {
        await recoverInterruptedVerification(
          input.projectRoot,
          input.repairId,
          error,
          verification,
        );
      } catch (recoveryError) {
        throw new AggregateError(
          [error, recoveryError],
          'Repair verification failed and bounded recovery also failed.',
        );
      }
    }
    throw error;
  } finally {
    await lock.release();
  }
}

export async function retryRepairCleanup(
  projectRoot: string,
  repairId: string,
): Promise<LocalRepairStateV1> {
  const lock = await acquireRepairLock(projectRoot);
  try {
    const bound = await readBoundRepairState(projectRoot, repairId);
    const statePath = bound.statePath;
    const state = structuredClone(bound.state);
    let head = await lifecycleHead(state);
    if (head === 'cleanup_completed') {
      state.state = 'cleanup_completed';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
      return deepFreeze(state);
    }
    if (
      ['verification_started', 'verification_passed', 'verification_failed'].includes(
        head,
      )
    ) {
      await recoverInterruptedVerification(
        projectRoot,
        repairId,
        new Error(
          'PP_REPAIR_VERIFICATION_INTERRUPTED: cleanup recovered an interrupted verification.',
        ),
      );
      return (await readBoundRepairState(projectRoot, repairId)).state;
    }
    if (
      [
        'created',
        'baseline_verified',
        'codex_completed',
        'candidate_policy_accepted',
      ].includes(head)
    ) {
      await retainInterruptedPreparation(
        statePath,
        state,
        head as Extract<
          RepairStateName,
          | 'created'
          | 'baseline_verified'
          | 'codex_completed'
          | 'candidate_policy_accepted'
        >,
      );
      head = 'evidence_saved';
    }
    if (head === 'human_rejected') {
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'evidence_saved',
        {
          decision: 'rejected',
          recovery: 'review_finalization_interrupted',
          approvalSha256: state.approvalSha256,
        },
      );
      head = 'evidence_saved';
      state.state = 'evidence_saved';
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);
    }
    if (head !== 'cleanup_failed' && head !== 'evidence_saved') {
      throw new Error(
        'PP_REPAIR_CLEANUP_STATE_INVALID: cleanup is allowed only after evidence is saved.',
      );
    }
    await recordCleanup(
      statePath,
      state,
      async () => {
        await cleanupVerificationWorktree(state);
        await cleanupCandidate(state);
      },
      state.verificationWorktreePath !== null,
    );
    return (await readBoundRepairState(projectRoot, repairId)).state;
  } finally {
    await lock.release();
  }
}
