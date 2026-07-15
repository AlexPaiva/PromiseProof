import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rm,
  rmdir,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import {
  assertCleanRepository,
  captureHeadRef,
  captureRefState,
  equalRefStates,
  isPathInside,
  listGitStatus,
  resolveCleanRepository,
  resolveRepositoryPath,
  runGit,
  type CleanRepositorySnapshot,
  type GitStatusEntry,
} from './git.js';

export const PROMISEPROOF_REPAIR_TEMP_DIRECTORY =
  'promiseproof-repair-worktrees' as const;

const SESSION_PREFIX = 'repair-';
const CHECKOUT_DIRECTORY = 'checkout';
const MAX_UNTRACKED_PATCH_INPUT_BYTES = 256 * 1024;
const MAX_INSPECTION_BUFFER_BYTES = 1024 * 1024;

export interface DisposableWorktreeOptions {
  /** Parent must resolve to the operating-system temporary directory or below. */
  readonly tempParent?: string;
  /** Optional exact UUID allocation used to bind a persisted repair role. */
  readonly allocationId?: string;
}

/**
 * An exact, process-bound allocation intent. Planning creates the shared safe
 * temp base when needed, but neither `tempRoot` nor `worktreePath` exists until
 * this plan is materialized.
 */
export interface PlannedDisposableWorktree {
  readonly allocationId: string;
  readonly repository: CleanRepositorySnapshot;
  readonly tempBase: string;
  readonly tempRoot: string;
  readonly worktreePath: string;
}

export interface DisposableWorktree {
  readonly repository: CleanRepositorySnapshot;
  readonly tempBase: string;
  readonly tempRoot: string;
  readonly worktreePath: string;
}

export interface UntrackedFileInspection {
  readonly path: string;
  readonly sizeBytes: number;
  readonly filesystemKind:
    | 'regular_file'
    | 'symbolic_link'
    | 'directory'
    | 'other';
  readonly patch: string | null;
  readonly patchOmittedReason: 'not_regular_file' | 'too_large' | null;
}

export interface WorktreeInspection {
  readonly status: readonly GitStatusEntry[];
  readonly trackedUnstagedPatch: string;
  readonly stagedPatch: string;
  readonly trackedUnstagedRawDiff: string;
  readonly stagedRawDiff: string;
  readonly untrackedFiles: readonly UntrackedFileInspection[];
  readonly combinedUnstagedPatch: string;
}

export class WorktreeBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorktreeBoundaryError';
    this.code = code;
  }
}

interface HandleState {
  readonly tempBase: string;
  readonly tempRoot: string;
  readonly worktreePath: string;
  readonly repository: CleanRepositorySnapshot;
  /** The live source checkout snapshot captured when this handle was opened. */
  readonly sourceRepository: CleanRepositorySnapshot;
  cleaned: boolean;
}

type PlanStatus =
  | 'planned'
  | 'materializing'
  | 'materialized'
  | 'cancelled'
  | 'failed';

interface PlanState {
  readonly allocationId: string;
  readonly tempBase: string;
  readonly tempRoot: string;
  readonly worktreePath: string;
  readonly repository: CleanRepositorySnapshot;
  status: PlanStatus;
}

const handleStates = new WeakMap<DisposableWorktree, HandleState>();
const planStates = new WeakMap<PlannedDisposableWorktree, PlanState>();

const ALLOCATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function repairWorktreeAllocationId(
  repairId: string,
  role: 'candidate' | 'verification',
): string {
  if (!ALLOCATION_ID_PATTERN.test(repairId)) {
    throw new TypeError('Repair worktree binding requires a version-4 UUID.');
  }
  if (role === 'candidate') {
    return repairId;
  }
  const bytes = createHash('sha256')
    .update(`promiseproof:verification-worktree:${repairId}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const format = (): string => {
    const hex = bytes.toString('hex');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  };
  if (format() === repairId) {
    bytes[15] = bytes[15]! ^ 0x01;
  }
  return format();
}

export async function expectedDefaultRepairWorktreePath(
  repairId: string,
  role: 'candidate' | 'verification',
): Promise<string> {
  const osTempRoot = await realpath(tmpdir());
  return join(
    osTempRoot,
    PROMISEPROOF_REPAIR_TEMP_DIRECTORY,
    `${SESSION_PREFIX}${repairWorktreeAllocationId(repairId, role)}`,
    CHECKOUT_DIRECTORY,
  );
}

function samePath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)).length === 0;
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

async function prepareTempBase(tempParent?: string): Promise<string> {
  const osTempRoot = await realpath(tmpdir());
  const requestedParent = await realpath(tempParent ?? osTempRoot);
  if (
    !samePath(osTempRoot, requestedParent) &&
    !isPathInside(osTempRoot, requestedParent)
  ) {
    throw new WorktreeBoundaryError(
      'temp_parent_outside_os_temp',
      'The disposable-worktree parent must be inside the OS temporary directory.',
    );
  }

  const tempBase = join(requestedParent, PROMISEPROOF_REPAIR_TEMP_DIRECTORY);
  const existing = await lstatOrNull(tempBase);
  if (existing !== null && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new WorktreeBoundaryError(
      'unsafe_temp_base',
      'The PromiseProof temporary root must be a real directory.',
    );
  }
  await mkdir(tempBase, { recursive: true, mode: 0o700 });

  const created = await lstat(tempBase);
  const resolvedBase = await realpath(tempBase);
  if (
    !created.isDirectory() ||
    created.isSymbolicLink() ||
    !isPathInside(requestedParent, resolvedBase) ||
    basename(resolvedBase) !== PROMISEPROOF_REPAIR_TEMP_DIRECTORY
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_temp_base',
      'The PromiseProof temporary root failed its containment check.',
    );
  }
  return resolvedBase;
}

function stateFor(handle: DisposableWorktree): HandleState {
  const state = handleStates.get(handle);
  if (state === undefined) {
    throw new WorktreeBoundaryError(
      'unrecognized_worktree_handle',
      'Refusing to operate on a worktree handle not created by this process.',
    );
  }
  if (state.cleaned) {
    throw new WorktreeBoundaryError(
      'worktree_already_cleaned',
      'The disposable worktree has already been cleaned.',
    );
  }
  return state;
}

function stateForPlan(plan: PlannedDisposableWorktree): PlanState {
  const state = planStates.get(plan);
  if (state === undefined) {
    throw new WorktreeBoundaryError(
      'unrecognized_worktree_plan',
      'Refusing to materialize a worktree plan not created by this process.',
    );
  }
  if (state.status !== 'planned') {
    throw new WorktreeBoundaryError(
      'worktree_plan_already_consumed',
      `The disposable-worktree plan is no longer pending (${state.status}).`,
    );
  }
  return state;
}

function equalRepositorySnapshots(
  left: CleanRepositorySnapshot,
  right: CleanRepositorySnapshot,
): boolean {
  return (
    samePath(left.repoRoot, right.repoRoot) &&
    samePath(left.gitCommonDir, right.gitCommonDir) &&
    left.baseHead === right.baseHead &&
    left.headRef === right.headRef &&
    equalRefStates(left.refState, right.refState)
  );
}

async function assertPlannedPathSafety(
  state: PlanState,
  options: { readonly requireAbsent: boolean },
): Promise<void> {
  const baseInfo = await lstatOrNull(state.tempBase);
  if (
    baseInfo === null ||
    !baseInfo.isDirectory() ||
    baseInfo.isSymbolicLink() ||
    basename(state.tempBase) !== PROMISEPROOF_REPAIR_TEMP_DIRECTORY ||
    !ALLOCATION_ID_PATTERN.test(state.allocationId) ||
    basename(state.tempRoot) !== `${SESSION_PREFIX}${state.allocationId}` ||
    !samePath(resolve(state.tempBase, basename(state.tempRoot)), state.tempRoot) ||
    !isPathInside(state.tempBase, state.tempRoot) ||
    basename(state.worktreePath) !== CHECKOUT_DIRECTORY ||
    !samePath(resolve(state.tempRoot, CHECKOUT_DIRECTORY), state.worktreePath) ||
    !isPathInside(state.tempRoot, state.worktreePath)
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_planned_path',
      'Disposable-worktree plan failed its lexical containment check.',
    );
  }

  const resolvedBase = await realpath(state.tempBase);
  if (!samePath(resolvedBase, state.tempBase)) {
    throw new WorktreeBoundaryError(
      'unsafe_planned_path',
      'PromiseProof temporary base resolved somewhere unexpected.',
    );
  }

  if (options.requireAbsent && (await lstatOrNull(state.tempRoot)) !== null) {
    throw new WorktreeBoundaryError(
      'planned_path_collision',
      'The exact planned disposable-worktree path already exists.',
    );
  }
}

async function assertOwnedPlannedRoot(state: PlanState): Promise<void> {
  await assertPlannedPathSafety(state, { requireAbsent: false });
  const rootInfo = await lstatOrNull(state.tempRoot);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'The planned disposable-worktree root is missing or unsafe.',
    );
  }
  const resolvedRoot = await realpath(state.tempRoot);
  if (!samePath(resolvedRoot, state.tempRoot)) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'The planned disposable-worktree root resolved somewhere unexpected.',
    );
  }
}

async function isRegisteredWorktree(
  repository: CleanRepositorySnapshot,
  worktreePath: string,
): Promise<boolean> {
  const result = await runGit(repository.repoRoot, [
    'worktree',
    'list',
    '--porcelain',
    '-z',
  ]);
  return result.stdout.split('\0').some((field) => {
    if (!field.startsWith('worktree ')) {
      return false;
    }
    return samePath(field.slice('worktree '.length), worktreePath);
  });
}

async function cleanupPartialMaterialization(state: PlanState): Promise<void> {
  await assertOwnedPlannedRoot(state);
  const checkoutInfo = await lstatOrNull(state.worktreePath);
  if (
    checkoutInfo !== null &&
    (!checkoutInfo.isDirectory() || checkoutInfo.isSymbolicLink())
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_cleanup_target',
      'Refusing cleanup after the planned checkout was replaced.',
    );
  }
  if (checkoutInfo !== null) {
    const resolvedCheckout = await realpath(state.worktreePath);
    if (!samePath(resolvedCheckout, state.worktreePath)) {
      throw new WorktreeBoundaryError(
        'unsafe_cleanup_target',
        'Refusing cleanup after the planned checkout moved outside its root.',
      );
    }
  }

  if (await isRegisteredWorktree(state.repository, state.worktreePath)) {
    await runGit(state.repository.repoRoot, [
      '-c',
      'core.hooksPath=',
      'worktree',
      'remove',
      '--force',
      state.worktreePath,
    ]);
  }
  if (await isRegisteredWorktree(state.repository, state.worktreePath)) {
    throw new WorktreeBoundaryError(
      'worktree_still_registered',
      'The failed disposable worktree remained registered with Git.',
    );
  }

  await rm(state.tempRoot, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 50,
  });
}

async function assertCreatedPathSafety(state: HandleState): Promise<void> {
  const baseInfo = await lstatOrNull(state.tempBase);
  if (
    baseInfo === null ||
    !baseInfo.isDirectory() ||
    baseInfo.isSymbolicLink() ||
    !isPathInside(state.tempBase, state.tempRoot) ||
    !isPathInside(state.tempRoot, state.worktreePath) ||
    basename(state.tempBase) !== PROMISEPROOF_REPAIR_TEMP_DIRECTORY ||
    basename(state.tempRoot).startsWith(SESSION_PREFIX) === false ||
    basename(state.worktreePath) !== CHECKOUT_DIRECTORY
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'Disposable-worktree paths failed lexical containment.',
    );
  }
  const resolvedBase = await realpath(state.tempBase);
  if (!samePath(resolvedBase, state.tempBase)) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'PromiseProof temporary base resolved somewhere unexpected.',
    );
  }

  const rootInfo = await lstatOrNull(state.tempRoot);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'Disposable-worktree root is missing or is not a real directory.',
    );
  }
  const resolvedRoot = await realpath(state.tempRoot);
  if (!samePath(resolvedRoot, state.tempRoot)) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'Disposable-worktree root resolved somewhere unexpected.',
    );
  }

  const checkoutInfo = await lstatOrNull(state.worktreePath);
  if (
    checkoutInfo === null ||
    !checkoutInfo.isDirectory() ||
    checkoutInfo.isSymbolicLink()
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'Disposable checkout is missing or is not a real directory.',
    );
  }
  const resolvedCheckout = await realpath(state.worktreePath);
  if (!samePath(resolvedCheckout, state.worktreePath)) {
    throw new WorktreeBoundaryError(
      'unsafe_created_path',
      'Disposable checkout resolved somewhere unexpected.',
    );
  }
}

async function removeCreatedPaths(state: HandleState): Promise<void> {
  await assertCreatedPathSafety(state);
  await assertNoReparsePointsBeforeCleanup(state.tempRoot);
  await runGit(state.repository.repoRoot, [
    '-c',
    'core.hooksPath=',
    'worktree',
    'remove',
    '--force',
    state.worktreePath,
  ]);

  const rootInfo = await lstatOrNull(state.tempRoot);
  if (rootInfo !== null) {
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new WorktreeBoundaryError(
        'unsafe_cleanup_target',
        'Refusing recursive cleanup of a replaced temporary root.',
      );
    }
    const resolvedRoot = await realpath(state.tempRoot);
    if (
      !samePath(resolvedRoot, state.tempRoot) ||
      !isPathInside(state.tempBase, resolvedRoot)
    ) {
      throw new WorktreeBoundaryError(
        'unsafe_cleanup_target',
        'Refusing recursive cleanup outside the created PromiseProof root.',
      );
    }
    await assertNoReparsePointsBeforeCleanup(resolvedRoot);
    await rm(resolvedRoot, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    });
  }
}

async function assertNoReparsePointsBeforeCleanup(
  directory: string,
): Promise<void> {
  for (const entry of await readdir(directory)) {
    const candidate = join(directory, entry);
    const info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      throw new WorktreeBoundaryError(
        'unsafe_cleanup_target',
        'Refusing recursive cleanup while a reparse point remains under the disposable root.',
      );
    }
    if (info.isDirectory()) {
      await assertNoReparsePointsBeforeCleanup(candidate);
    }
  }
}

export async function planDisposableWorktree(
  repositoryPath: string,
  options: DisposableWorktreeOptions = {},
): Promise<PlannedDisposableWorktree> {
  const repository = await resolveCleanRepository(repositoryPath);
  const tempBase = await prepareTempBase(options.tempParent);
  const allocationId = options.allocationId ?? randomUUID();
  if (!ALLOCATION_ID_PATTERN.test(allocationId)) {
    throw new WorktreeBoundaryError(
      'invalid_allocation_id',
      'Disposable worktree allocation must be an exact version-4 UUID.',
    );
  }
  const tempRoot = join(tempBase, `${SESSION_PREFIX}${allocationId}`);
  const worktreePath = join(tempRoot, CHECKOUT_DIRECTORY);
  const plan: PlannedDisposableWorktree = Object.freeze({
    allocationId,
    repository,
    tempBase,
    tempRoot,
    worktreePath,
  });
  const state: PlanState = {
    allocationId,
    repository,
    tempBase,
    tempRoot,
    worktreePath,
    status: 'planned',
  };
  planStates.set(plan, state);
  try {
    await assertPlannedPathSafety(state, { requireAbsent: true });
    return plan;
  } catch (error) {
    state.status = 'failed';
    throw error;
  }
}

export async function cleanupPlannedDisposableWorktree(
  plan: PlannedDisposableWorktree,
): Promise<void> {
  const state = stateForPlan(plan);
  await assertPlannedPathSafety(state, { requireAbsent: true });
  state.status = 'cancelled';
}

export async function materializeDisposableWorktree(
  plan: PlannedDisposableWorktree,
): Promise<DisposableWorktree> {
  const state = stateForPlan(plan);
  state.status = 'materializing';
  let rootCreated = false;
  let handle: DisposableWorktree | undefined;
  try {
    await assertPlannedPathSafety(state, { requireAbsent: true });
    const currentRepository = await resolveCleanRepository(
      state.repository.repoRoot,
    );
    if (!equalRepositorySnapshots(currentRepository, state.repository)) {
      throw new WorktreeBoundaryError(
        'repository_snapshot_changed',
        'The repository changed after the disposable worktree was planned.',
      );
    }

    // Close the path-allocation race after the slower Git snapshot check. The
    // non-recursive mkdir atomically claims exactly the persisted UUID path.
    await assertPlannedPathSafety(state, { requireAbsent: true });
    try {
      await mkdir(state.tempRoot, { mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'EEXIST'
      ) {
        throw new WorktreeBoundaryError(
          'planned_path_collision',
          'The exact planned disposable-worktree path was claimed before materialization.',
          { cause: error },
        );
      }
      throw error;
    }
    await assertOwnedPlannedRoot(state);

    await runGit(state.repository.repoRoot, [
      '-c',
      'core.hooksPath=',
      'worktree',
      'add',
      '--detach',
      state.worktreePath,
      state.repository.baseHead,
    ]);
    const resolvedWorktree = await realpath(state.worktreePath);
    if (!samePath(resolvedWorktree, state.worktreePath)) {
      throw new WorktreeBoundaryError(
        'unsafe_created_path',
        'Created checkout resolved somewhere unexpected.',
      );
    }

    handle = Object.freeze({
      repository: state.repository,
      tempBase: state.tempBase,
      tempRoot: state.tempRoot,
      worktreePath: resolvedWorktree,
    });
    handleStates.set(handle, {
      tempBase: state.tempBase,
      tempRoot: state.tempRoot,
      worktreePath: resolvedWorktree,
      repository: state.repository,
      sourceRepository: state.repository,
      cleaned: false,
    });

    await assertCleanRepository(resolvedWorktree);
    await verifyDisposableWorktree(handle);
    state.status = 'materialized';
    return handle;
  } catch (error) {
    state.status = 'failed';
    if (rootCreated) {
      try {
        await cleanupPartialMaterialization(state);
        if (handle !== undefined) {
          const handleState = handleStates.get(handle);
          if (handleState !== undefined) {
            handleState.cleaned = true;
          }
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Worktree materialization failed and safe cleanup also failed.',
        );
      }
    }
    throw error;
  }
}

export async function createDisposableWorktree(
  repositoryPath: string,
  options: DisposableWorktreeOptions = {},
): Promise<DisposableWorktree> {
  const plan = await planDisposableWorktree(repositoryPath, options);
  return await materializeDisposableWorktree(plan);
}

/**
 * Cleans a path that was persisted from an authentic plan before a process
 * crashed. A materialized checkout is handled through the normal registered
 * worktree boundary. An unmaterialized UUID root is removed only when it is a
 * real, empty directory and Git has no registration for the exact checkout.
 */
export async function cleanupPersistedDisposableWorktreeIntent(
  repositoryPath: string,
  worktreePath: string,
): Promise<'absent' | 'unmaterialized' | 'materialized'> {
  const repository = await resolveCleanRepository(repositoryPath);
  const tempBase = await prepareTempBase();
  const normalizedWorktree = resolve(worktreePath);
  const tempRoot = resolve(normalizedWorktree, '..');
  const allocationId = basename(tempRoot).slice(SESSION_PREFIX.length);
  if (
    basename(normalizedWorktree) !== CHECKOUT_DIRECTORY ||
    !ALLOCATION_ID_PATTERN.test(allocationId) ||
    basename(tempRoot) !== `${SESSION_PREFIX}${allocationId}` ||
    !samePath(resolve(tempRoot, '..'), tempBase) ||
    !isPathInside(tempBase, tempRoot) ||
    !isPathInside(tempRoot, normalizedWorktree)
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_persisted_intent',
      'Persisted disposable-worktree intent is outside the canonical UUID boundary.',
    );
  }

  const checkoutInfo = await lstatOrNull(normalizedWorktree);
  if (checkoutInfo !== null) {
    const handle = await reopenDisposableWorktree(
      repository.repoRoot,
      normalizedWorktree,
    );
    await cleanupDisposableWorktree(handle);
    return 'materialized';
  }
  if (await isRegisteredWorktree(repository, normalizedWorktree)) {
    throw new WorktreeBoundaryError(
      'worktree_still_registered',
      'Missing persisted checkout remains registered with Git.',
    );
  }

  const rootInfo = await lstatOrNull(tempRoot);
  if (rootInfo === null) {
    return 'absent';
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WorktreeBoundaryError(
      'unsafe_cleanup_target',
      'Persisted unmaterialized root is not one real directory.',
    );
  }
  const resolvedRoot = await realpath(tempRoot);
  if (!samePath(resolvedRoot, tempRoot) || (await readdir(resolvedRoot)).length !== 0) {
    throw new WorktreeBoundaryError(
      'unsafe_cleanup_target',
      'Persisted unmaterialized root moved or contains untrusted content.',
    );
  }
  await rmdir(resolvedRoot);
  return 'unmaterialized';
}

/**
 * Reconstructs a handle for a still-registered PromiseProof worktree in a new
 * process. Every path and Git boundary is revalidated; callers cannot forge a
 * cleanup handle from an arbitrary directory.
 */
async function reopenDisposableWorktreeAtBase(
  repositoryPath: string,
  worktreePath: string,
  options: DisposableWorktreeOptions,
  expectedBaseHead: string | null,
  expectedAllocationId: string | null,
): Promise<DisposableWorktree> {
  const sourceRepository = await resolveCleanRepository(repositoryPath);
  let repository = sourceRepository;
  if (expectedBaseHead !== null) {
    if (!/^[a-f0-9]{40,64}$/u.test(expectedBaseHead)) {
      throw new WorktreeBoundaryError(
        'invalid_retained_base',
        'Retained disposable-worktree base must be an exact Git object ID.',
      );
    }
    const resolvedBase = (
      await runGit(sourceRepository.repoRoot, [
        'rev-parse',
        '--verify',
        `${expectedBaseHead}^{commit}`,
      ])
    ).stdout.trim();
    if (resolvedBase !== expectedBaseHead) {
      throw new WorktreeBoundaryError(
        'invalid_retained_base',
        'Retained disposable-worktree base does not resolve to the exact expected commit.',
      );
    }
    repository = Object.freeze({
      ...sourceRepository,
      baseHead: expectedBaseHead,
    });
  }
  const tempBase = await prepareTempBase(options.tempParent);
  const lexicalWorktree = resolve(worktreePath);
  const lexicalTempRoot = resolve(lexicalWorktree, '..');
  const [lexicalRootInfo, lexicalWorktreeInfo] = await Promise.all([
    lstat(lexicalTempRoot),
    lstat(lexicalWorktree),
  ]);
  if (
    !lexicalRootInfo.isDirectory() ||
    lexicalRootInfo.isSymbolicLink() ||
    !lexicalWorktreeInfo.isDirectory() ||
    lexicalWorktreeInfo.isSymbolicLink()
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_reopened_path',
      'Persisted worktree path must be one real allocation root and checkout.',
    );
  }
  const resolvedWorktree = await realpath(lexicalWorktree);
  const resolvedTempRoot = await realpath(resolve(resolvedWorktree, '..'));
  const [rootInfo, worktreeInfo] = await Promise.all([
    lstat(resolvedTempRoot),
    lstat(resolvedWorktree),
  ]);
  const reopenedRootName = basename(resolvedTempRoot);
  const reopenedAllocationId = reopenedRootName.slice(SESSION_PREFIX.length);
  if (
    basename(resolvedWorktree) !== CHECKOUT_DIRECTORY ||
    !samePath(resolve(resolvedTempRoot, '..'), tempBase) ||
    !ALLOCATION_ID_PATTERN.test(reopenedAllocationId) ||
    reopenedRootName !== `${SESSION_PREFIX}${reopenedAllocationId}` ||
    (expectedAllocationId !== null &&
      (reopenedAllocationId !== expectedAllocationId ||
        !samePath(resolvedTempRoot, lexicalTempRoot))) ||
    !isPathInside(tempBase, resolvedTempRoot) ||
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !worktreeInfo.isDirectory() ||
    worktreeInfo.isSymbolicLink()
  ) {
    throw new WorktreeBoundaryError(
      'unsafe_reopened_path',
      'Persisted worktree path is outside the PromiseProof temporary boundary.',
    );
  }

  const handle: DisposableWorktree = Object.freeze({
    repository,
    tempBase,
    tempRoot: resolvedTempRoot,
    worktreePath: resolvedWorktree,
  });
  handleStates.set(handle, {
    tempBase,
    tempRoot: resolvedTempRoot,
    worktreePath: resolvedWorktree,
    repository,
    sourceRepository,
    cleaned: false,
  });
  try {
    await verifyDisposableWorktree(handle);
    return handle;
  } catch (error) {
    handleStates.delete(handle);
    throw error;
  }
}

export async function reopenDisposableWorktree(
  repositoryPath: string,
  worktreePath: string,
  options: DisposableWorktreeOptions = {},
): Promise<DisposableWorktree> {
  return await reopenDisposableWorktreeAtBase(
    repositoryPath,
    worktreePath,
    options,
    null,
    null,
  );
}

/**
 * Reopens a retained candidate after the source checkout has deliberately
 * advanced. The old commit is accepted only as the detached worktree base;
 * the live source checkout still receives a fresh clean snapshot and all
 * ordinary HEAD, branch, ref, common-directory, and path checks.
 */
export async function reopenRetainedDisposableWorktree(
  repositoryPath: string,
  worktreePath: string,
  input: {
    readonly expectedAllocationId: string;
    readonly expectedBaseHead: string;
    readonly tempParent?: string;
  },
): Promise<DisposableWorktree> {
  if (!ALLOCATION_ID_PATTERN.test(input.expectedAllocationId)) {
    throw new WorktreeBoundaryError(
      'invalid_allocation_id',
      'Retained worktree binding requires an exact version-4 UUID.',
    );
  }
  const expectedRootName = `${SESSION_PREFIX}${input.expectedAllocationId}`;
  if (basename(resolve(worktreePath, '..')) !== expectedRootName) {
    throw new WorktreeBoundaryError(
      'retained_allocation_changed',
      'Retained worktree path does not match its exact persisted allocation.',
    );
  }
  return await reopenDisposableWorktreeAtBase(
    repositoryPath,
    worktreePath,
    input.tempParent === undefined ? {} : { tempParent: input.tempParent },
    input.expectedBaseHead,
    input.expectedAllocationId,
  );
}

export async function verifyDisposableWorktree(
  handle: DisposableWorktree,
): Promise<void> {
  const state = stateFor(handle);
  await assertCreatedPathSafety(state);

  const worktreeRootResult = await runGit(state.worktreePath, [
    'rev-parse',
    '--show-toplevel',
  ]);
  const worktreeRoot = await realpath(worktreeRootResult.stdout.trim());
  if (!samePath(worktreeRoot, state.worktreePath)) {
    throw new WorktreeBoundaryError(
      'worktree_root_changed',
      'The disposable checkout no longer resolves to its created Git worktree.',
    );
  }

  const commonDirResult = await runGit(state.worktreePath, [
    'rev-parse',
    '--git-common-dir',
  ]);
  const commonDir = await realpath(
    resolve(state.worktreePath, commonDirResult.stdout.trim()),
  );
  if (!samePath(commonDir, state.repository.gitCommonDir)) {
    throw new WorktreeBoundaryError(
      'git_common_dir_changed',
      'The disposable checkout is no longer attached to the expected repository.',
    );
  }

  const headResult = await runGit(state.worktreePath, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  if (headResult.stdout.trim() !== state.repository.baseHead) {
    throw new WorktreeBoundaryError(
      'worktree_head_changed',
      'The disposable worktree HEAD no longer equals the exact base commit.',
    );
  }
  if ((await captureHeadRef(state.worktreePath)) !== null) {
    throw new WorktreeBoundaryError(
      'worktree_not_detached',
      'The disposable worktree must remain detached.',
    );
  }

  const originalHeadResult = await runGit(state.sourceRepository.repoRoot, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  if (originalHeadResult.stdout.trim() !== state.sourceRepository.baseHead) {
    throw new WorktreeBoundaryError(
      'repository_head_changed',
      'The source checkout HEAD changed during repair preparation.',
    );
  }
  if (
    (await captureHeadRef(state.sourceRepository.repoRoot)) !==
    state.sourceRepository.headRef
  ) {
    throw new WorktreeBoundaryError(
      'repository_head_ref_changed',
      'The source checkout branch/detached state changed during repair preparation.',
    );
  }
  const currentRefs = await captureRefState(state.sourceRepository.repoRoot);
  if (!equalRefStates(currentRefs, state.sourceRepository.refState)) {
    throw new WorktreeBoundaryError(
      'repository_refs_changed',
      'Git references changed during repair preparation.',
    );
  }
  await assertCleanRepository(state.sourceRepository.repoRoot);
}

function joinPatches(parts: readonly string[]): string {
  const normalized = parts
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/\r\n/gu, '\n').replace(/\n*$/u, '\n'));
  return normalized.join('');
}

export async function inspectDisposableWorktree(
  handle: DisposableWorktree,
): Promise<WorktreeInspection> {
  const state = stateFor(handle);
  await verifyDisposableWorktree(handle);

  const status = await listGitStatus(state.worktreePath, {
    includeIgnored: true,
  });
  const trackedUnstagedPatch = (
    await runGit(
      state.worktreePath,
      [
        'diff',
        '--no-ext-diff',
        '--binary',
        '--full-index',
        '--no-renames',
        '--',
      ],
      { maxBufferBytes: MAX_INSPECTION_BUFFER_BYTES },
    )
  ).stdout;
  const stagedPatch = (
    await runGit(
      state.worktreePath,
      [
        'diff',
        '--cached',
        '--no-ext-diff',
        '--binary',
        '--full-index',
        '--no-renames',
        '--',
      ],
      { maxBufferBytes: MAX_INSPECTION_BUFFER_BYTES },
    )
  ).stdout;
  const trackedUnstagedRawDiff = (
    await runGit(state.worktreePath, [
      'diff',
      '--no-ext-diff',
      '--raw',
      '-z',
      '--no-renames',
      '--',
    ])
  ).stdout;
  const stagedRawDiff = (
    await runGit(state.worktreePath, [
      'diff',
      '--cached',
      '--no-ext-diff',
      '--raw',
      '-z',
      '--no-renames',
      '--',
    ])
  ).stdout;

  const untrackedFiles: UntrackedFileInspection[] = [];
  for (const entry of status) {
    if (entry.kind !== 'untracked') {
      continue;
    }
    const absolutePath = resolveRepositoryPath(state.worktreePath, entry.path);
    const info = await lstat(absolutePath);
    const filesystemKind = info.isSymbolicLink()
      ? 'symbolic_link'
      : info.isFile()
        ? 'regular_file'
        : info.isDirectory()
          ? 'directory'
          : 'other';

    let patch: string | null = null;
    let patchOmittedReason: UntrackedFileInspection['patchOmittedReason'] = null;
    if (filesystemKind !== 'regular_file') {
      patchOmittedReason = 'not_regular_file';
    } else if (info.size > MAX_UNTRACKED_PATCH_INPUT_BYTES) {
      patchOmittedReason = 'too_large';
    } else {
      patch = (
        await runGit(
          state.worktreePath,
          [
            'diff',
            '--no-index',
            '--no-ext-diff',
            '--binary',
            '--full-index',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            '--',
            '/dev/null',
            entry.path,
          ],
          {
            acceptedExitCodes: [0, 1],
            maxBufferBytes: MAX_INSPECTION_BUFFER_BYTES,
          },
        )
      ).stdout;
    }

    untrackedFiles.push(
      Object.freeze({
        path: entry.path,
        sizeBytes: info.size,
        filesystemKind,
        patch,
        patchOmittedReason,
      }),
    );
  }

  await verifyDisposableWorktree(handle);
  const combinedUnstagedPatch = joinPatches([
    trackedUnstagedPatch,
    ...untrackedFiles.flatMap((file) =>
      file.patch === null ? [] : [file.patch],
    ),
  ]);

  return Object.freeze({
    status,
    trackedUnstagedPatch,
    stagedPatch,
    trackedUnstagedRawDiff,
    stagedRawDiff,
    untrackedFiles: Object.freeze(untrackedFiles),
    combinedUnstagedPatch,
  });
}

export async function cleanupDisposableWorktree(
  handle: DisposableWorktree,
): Promise<void> {
  const state = stateFor(handle);
  await removeCreatedPaths(state);
  state.cleaned = true;
}
