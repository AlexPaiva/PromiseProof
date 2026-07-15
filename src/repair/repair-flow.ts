import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import {
  canonicalJson,
  sha256CanonicalJson,
} from '../investigation/canonical-json.js';
import { deepFreeze } from '../investigation/immutable.js';
import {
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  readRepairLifecycle,
  sha256Bytes,
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
  validateRepairDiff,
} from './diff-validator.js';
import {
  equalIntegrityRefStates,
  INTEGRITY_REF_POLICY,
  integrityRefState,
  isVolatileCodexTurnDiffCaptureRef,
  resolveCleanRepository,
  resolveRepositoryPath,
  runGit,
  type GitRefEntry,
  type GitRefState,
} from './git.js';
import {
  expectedRetirementPhrase,
  humanRepairRetirementSchema,
  parseRetirementPhrase,
  readHumanRepairRetirement,
  REPAIR_RETIREMENT_REASON,
  REPAIR_RETIREMENT_VERSION,
  type HumanRepairRetirementV1,
} from './retirement.js';
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
import { cleanupIsolatedProviderRuntime } from './windows-sandbox.js';
import {
  cleanupDisposableWorktree,
  cleanupPersistedDisposableWorktreeIntent,
  expectedDefaultRepairWorktreePath,
  materializeDisposableWorktree,
  planDisposableWorktree,
  repairWorktreeAllocationId,
  reopenDisposableWorktree,
  reopenRetainedDisposableWorktree,
  verifyDisposableWorktree,
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

export interface RepairRetirementResult {
  readonly statePath: string;
  readonly retirementPath: string;
  readonly decision: HumanRepairRetirementV1;
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
  const [expectedCandidatePath, expectedVerificationPath] = await Promise.all([
    expectedDefaultRepairWorktreePath(repairId, 'candidate'),
    expectedDefaultRepairWorktreePath(repairId, 'verification'),
  ]);
  if (
    state.repairId !== repairId ||
    !sameFilesystemPath(state.projectRoot, repository.repoRoot) ||
    !sameFilesystemPath(state.artifactDirectory, expectedArtifactDirectory) ||
    !sameFilesystemPath(path.dirname(statePath), expectedArtifactDirectory) ||
    !sameFilesystemPath(state.candidateWorktreePath, expectedCandidatePath) ||
    (state.verificationWorktreePath !== null &&
      !sameFilesystemPath(
        state.verificationWorktreePath,
        expectedVerificationPath,
      ))
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
  await cleanupIsolatedProviderRuntime({
    tempRoot: path.dirname(state.candidateWorktreePath),
    codexHomePath: state.codexHomePath,
    toolTempPath: state.toolTempPath,
  });
  if (!(await pathExists(state.candidateWorktreePath))) {
    await cleanupPersistedDisposableWorktreeIntent(
      state.projectRoot,
      state.candidateWorktreePath,
    );
    return;
  }
  const candidate = await reopenRetainedDisposableWorktree(
    state.projectRoot,
    state.candidateWorktreePath,
    {
      expectedAllocationId: repairWorktreeAllocationId(
        state.repairId,
        'candidate',
      ),
      expectedBaseHead: state.baseCommit,
    },
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

function reconciliationFailure(message: string, cause?: unknown): never {
  throw new Error(
    `PP_REPAIR_REVIEW_RECONCILIATION_INVALID: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

async function assertCanonicalRepairArtifact(
  candidate: string,
  kind: 'directory' | 'file',
): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  let resolved: string;
  try {
    [info, resolved] = await Promise.all([
      lstat(candidate),
      realpath(candidate),
    ]);
  } catch (error) {
    reconciliationFailure(
      `retained ${kind} is missing or cannot be resolved.`,
      error,
    );
  }
  const hasExpectedKind =
    kind === 'directory' ? info.isDirectory() : info.isFile();
  if (
    info.isSymbolicLink() ||
    !hasExpectedKind ||
    (kind === 'file' && info.nlink !== 1) ||
    !sameFilesystemPath(resolved, candidate)
  ) {
    reconciliationFailure(
      `retained ${kind} is not one real object at its canonical path.`,
    );
  }
}

function refEntryChanged(left: GitRefEntry, right: GitRefEntry): boolean {
  return (
    left.objectId !== right.objectId ||
    left.symbolicTarget !== right.symbolicTarget
  );
}

function summarizeRefDrift(
  retained: GitRefState,
  observed: GitRefState,
): Pick<HumanRepairRetirementV1['drift'],
  | 'securityRelevantRefsAdded'
  | 'securityRelevantRefsRemoved'
  | 'securityRelevantRefsChanged'
> {
  const retainedByName = new Map(
    retained.refs.map((entry) => [entry.name, entry] as const),
  );
  const observedByName = new Map(
    observed.refs.map((entry) => [entry.name, entry] as const),
  );
  let securityRelevantRefsAdded = 0;
  let securityRelevantRefsRemoved = 0;
  let securityRelevantRefsChanged = 0;

  for (const name of new Set([
    ...retainedByName.keys(),
    ...observedByName.keys(),
  ])) {
    const before = retainedByName.get(name);
    const after = observedByName.get(name);
    const volatile = isVolatileCodexTurnDiffCaptureRef(name);
    if (volatile) {
      continue;
    }
    if (before === undefined) {
      securityRelevantRefsAdded += 1;
    } else if (after === undefined) {
      securityRelevantRefsRemoved += 1;
    } else if (refEntryChanged(before, after)) {
      securityRelevantRefsChanged += 1;
    }
  }

  return {
    securityRelevantRefsAdded,
    securityRelevantRefsRemoved,
    securityRelevantRefsChanged,
  };
}

function retirementFailure(
  decision: HumanRepairRetirementV1,
): NonNullable<LocalRepairStateV1['failure']> {
  return {
    stage: 'verification_precondition',
    code: REPAIR_RETIREMENT_REASON,
    message:
      'Human-approved candidate retired after the source integrity base changed; verification never started, no verification worktree was retained at the decision, and Playwright was not invoked.',
    recordedAt: decision.decidedAt,
  };
}

function retirementDecisionPath(state: LocalRepairStateV1): string {
  return path.join(state.artifactDirectory, 'retirement-decision.json');
}

function retirementLifecyclePayload(
  decision: HumanRepairRetirementV1,
  decisionSha256: string,
): Readonly<Record<string, unknown>> {
  return {
    decision,
    retirementDecisionSha256: decisionSha256,
  };
}

function retirementEvidencePayload(
  decision: HumanRepairRetirementV1,
  decisionSha256: string,
): Readonly<Record<string, unknown>> {
  return {
    disposition: decision.disposition,
    verificationVerdict: decision.verificationVerdict,
    verificationStarted: decision.verificationStarted,
    playwrightInvoked: decision.playwrightInvoked,
    retirementDecisionSha256: decisionSha256,
    patchSha256: decision.patchSha256,
    approvalSha256: decision.approvalSha256,
    nextAction: decision.nextAction,
  };
}

async function assertRetainedCandidateMatchesPatch(
  state: LocalRepairStateV1,
): Promise<DisposableWorktree> {
  if (state.patch === null) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_STATE_INVALID: retained patch record is missing.',
    );
  }
  for (const [candidate, kind] of [
    [state.artifactDirectory, 'directory'],
    [state.lifecyclePath, 'file'],
    [state.patchPath, 'file'],
    [state.approvalPath, 'file'],
  ] as const) {
    await assertCanonicalRepairArtifact(candidate, kind);
  }
  const retainedPatchBytes = await readFile(state.patchPath);
  if (
    retainedPatchBytes.byteLength !== state.patch.bytes ||
    sha256Bytes(retainedPatchBytes) !== state.patch.sha256
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_PATCH_CHANGED: retained patch bytes no longer match state.',
    );
  }

  const candidate = await reopenRetainedDisposableWorktree(
    state.projectRoot,
    state.candidateWorktreePath,
    {
      expectedAllocationId: repairWorktreeAllocationId(
        state.repairId,
        'candidate',
      ),
      expectedBaseHead: state.baseCommit,
    },
  );
  const validated = await validateRepairDiff(candidate);
  const sourcePath = resolveRepositoryPath(
    candidate.worktreePath,
    'src/client/main.ts',
  );
  const regressionPath = resolveRepositoryPath(
    candidate.worktreePath,
    'tests/regression/initialization-order.spec.ts',
  );
  const [baseSource, sourceAfterSha256, regressionAfterSha256] =
    await Promise.all([
      runGit(candidate.worktreePath, [
        'show',
        `${state.baseCommit}:src/client/main.ts`,
      ]),
      fileSha256(sourcePath),
      fileSha256(regressionPath),
    ]);
  const expectedPatch = {
    sha256: validated.patchSha256,
    bytes: validated.patchBytes,
    additions: validated.addedLines,
    deletions: validated.deletedLines,
    changedFiles: [
      {
        path: 'src/client/main.ts' as const,
        status: 'modified' as const,
        beforeSha256: sha256Bytes(baseSource.stdout),
        afterSha256: sourceAfterSha256,
      },
      {
        path: 'tests/regression/initialization-order.spec.ts' as const,
        status: 'added' as const,
        beforeSha256: null,
        afterSha256: regressionAfterSha256,
      },
    ],
  };
  if (
    !retainedPatchBytes.equals(Buffer.from(validated.patch, 'utf8')) ||
    canonicalJson(expectedPatch) !== canonicalJson(state.patch)
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_CANDIDATE_CHANGED: candidate no longer matches the approved retained patch.',
    );
  }
  return candidate;
}

async function readValidatedRetirementDecision(
  state: LocalRepairStateV1,
): Promise<{
  readonly decision: HumanRepairRetirementV1;
  readonly decisionSha256: string;
}> {
  if (state.patch === null || state.approvalSha256 === null) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retained patch or approval digest is missing.',
    );
  }
  const decisionPath = retirementDecisionPath(state);
  await Promise.all([
    assertCanonicalRepairArtifact(decisionPath, 'file'),
    assertCanonicalRepairArtifact(state.patchPath, 'file'),
    assertCanonicalRepairArtifact(state.approvalPath, 'file'),
  ]);
  const [decision, decisionSha256, approval, approvalSha256, patchSha256] = await Promise.all([
    readHumanRepairRetirement(decisionPath),
    fileSha256(decisionPath),
    readHumanDecision(state.approvalPath),
    fileSha256(state.approvalPath),
    fileSha256(state.patchPath),
  ]);
  if (
    decision.repairId !== state.repairId ||
    decision.patchSha256 !== state.patch.sha256 ||
    decision.patchBytes !== state.patch.bytes ||
    decision.approvalSha256 !== state.approvalSha256 ||
    decision.retainedBaseCommit !== state.baseCommit ||
    decision.retainedBaseTree !== state.baseTree ||
    decision.retainedHeadRef !== state.baseHeadRef ||
    decision.retainedFullRefStateSha256 !==
      sha256CanonicalJson(state.baseRefState) ||
    decision.retainedIntegrityRefStateSha256 !==
      sha256CanonicalJson(integrityRefState(state.baseRefState)) ||
    approval.decision !== 'approved' ||
    approval.repairId !== state.repairId ||
    approval.patchSha256 !== state.patch.sha256 ||
    approval.patchBytes !== state.patch.bytes ||
    approvalSha256 !== state.approvalSha256 ||
    patchSha256 !== state.patch.sha256
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retirement decision does not bind the retained candidate.',
    );
  }
  return { decision, decisionSha256 };
}

interface DerivedRetirementContext {
  readonly repository: Awaited<ReturnType<typeof resolveCleanRepository>>;
  readonly observedCurrentTree: string;
  readonly drift: HumanRepairRetirementV1['drift'];
  readonly observedIntegrityRefStateSha256: string;
}

async function deriveRetirementContext(
  state: LocalRepairStateV1,
): Promise<DerivedRetirementContext> {
  const repository = await resolveCleanRepository(state.projectRoot);
  const headChanged = repository.baseHead !== state.baseCommit;
  const headRefChanged = repository.headRef !== state.baseHeadRef;
  const integrityRefsChanged = !equalIntegrityRefStates(
    repository.refState,
    state.baseRefState,
  );
  if (!headChanged && !headRefChanged && !integrityRefsChanged) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_NOT_REQUIRED: the approved candidate still has an unchanged verification base.',
    );
  }
  if (headRefChanged) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_DRIFT_UNSAFE: source checkout branch or detached state changed.',
    );
  }
  if (headChanged) {
    const ancestry = await runGit(
      repository.repoRoot,
      ['merge-base', '--is-ancestor', state.baseCommit, repository.baseHead],
      { acceptedExitCodes: [0, 1] },
    );
    if (ancestry.exitCode !== 0) {
      throw new Error(
        'PP_REPAIR_RETIREMENT_DRIFT_UNSAFE: current source commit is not a descendant of the retained base.',
      );
    }
  }
  const [retainedTreeResult, currentTreeResult] = await Promise.all([
    runGit(repository.repoRoot, [
      'rev-parse',
      '--verify',
      `${state.baseCommit}^{tree}`,
    ]),
    runGit(repository.repoRoot, [
      'rev-parse',
      '--verify',
      `${repository.baseHead}^{tree}`,
    ]),
  ]);
  if (retainedTreeResult.stdout.trim() !== state.baseTree) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_BASE_INVALID: retained base tree no longer matches Git.',
    );
  }
  return {
    repository,
    observedCurrentTree: currentTreeResult.stdout.trim(),
    drift: {
      headChanged,
      headRefChanged,
      integrityRefsChanged,
      ...summarizeRefDrift(state.baseRefState, repository.refState),
    },
    observedIntegrityRefStateSha256: sha256CanonicalJson(
      integrityRefState(repository.refState),
    ),
  };
}

async function assertRetirementObservedContext(
  state: LocalRepairStateV1,
  decision: HumanRepairRetirementV1,
): Promise<void> {
  const current = await deriveRetirementContext(state);
  if (
    current.repository.baseHead !== decision.observedCurrentCommit ||
    current.observedCurrentTree !== decision.observedCurrentTree ||
    current.repository.headRef !== decision.observedCurrentHeadRef ||
    current.observedIntegrityRefStateSha256 !==
      decision.observedIntegrityRefStateSha256 ||
    current.drift.headChanged !== decision.drift.headChanged ||
    current.drift.headRefChanged !== decision.drift.headRefChanged ||
    current.drift.integrityRefsChanged !== decision.drift.integrityRefsChanged ||
    current.drift.securityRelevantRefsAdded !==
      decision.drift.securityRelevantRefsAdded ||
    current.drift.securityRelevantRefsRemoved !==
      decision.drift.securityRelevantRefsRemoved ||
    current.drift.securityRelevantRefsChanged !==
      decision.drift.securityRelevantRefsChanged
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_CONTEXT_CHANGED: source integrity base differs from the retained human decision.',
    );
  }
}

async function assertNoRetainedVerificationForRetirement(
  state: LocalRepairStateV1,
): Promise<void> {
  const expectedVerificationWorktree =
    await expectedDefaultRepairWorktreePath(
      state.repairId,
      'verification',
    );
  const verificationAllocationRoot = path.dirname(
    expectedVerificationWorktree,
  );
  const registeredWorktrees = await registeredWorktreePaths(state.projectRoot);
  if (
    ['verification_started', 'verification_passed', 'verification_failed'].includes(
      state.state,
    ) ||
    state.verificationWorktreePath !== null ||
    state.verificationReceiptPath !== null ||
    state.verificationReceiptSha256 !== null ||
    (await pathExists(path.join(state.artifactDirectory, 'verification'))) ||
    (await pathExists(verificationAllocationRoot)) ||
    registeredWorktrees.some((registered) =>
      sameFilesystemPath(registered, expectedVerificationWorktree),
    )
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_VERIFICATION_PRESENT: an unverified retirement cannot retain verification state or artifacts.',
    );
  }
}

async function registeredWorktreePaths(
  projectRoot: string,
): Promise<readonly string[]> {
  return (
    await runGit(projectRoot, ['worktree', 'list', '--porcelain', '-z'])
  ).stdout
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length));
}

async function assertCandidateAbsentAfterRetirementCleanup(
  state: LocalRepairStateV1,
): Promise<void> {
  const expectedCandidateWorktree = await expectedDefaultRepairWorktreePath(
    state.repairId,
    'candidate',
  );
  const registeredWorktrees = await registeredWorktreePaths(state.projectRoot);
  if (
    (await pathExists(path.dirname(expectedCandidateWorktree))) ||
    registeredWorktrees.some((registered) =>
      sameFilesystemPath(registered, expectedCandidateWorktree),
    )
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_CANDIDATE_PRESENT: completed retirement cleanup cannot retain or recreate the candidate allocation.',
    );
  }
}

function assertRetirementReconciliationWindow(
  lifecycleHead: RepairStateName,
  retainedState: RepairStateName,
): void {
  const allowedRetainedStates: Partial<
    Record<RepairStateName, readonly RepairStateName[]>
  > = {
    human_approved: ['human_approved'],
    retired_without_verification: [
      'human_approved',
      'retired_without_verification',
    ],
    evidence_saved: [
      'human_approved',
      'retired_without_verification',
      'evidence_saved',
    ],
    cleanup_failed: ['evidence_saved', 'cleanup_failed'],
    cleanup_completed: [
      'evidence_saved',
      'cleanup_failed',
      'cleanup_completed',
    ],
  };
  if (!allowedRetainedStates[lifecycleHead]?.includes(retainedState)) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retained state is not a valid lifecycle-first retirement crash window.',
    );
  }
}

async function reconcileRetirementEvidence(
  statePath: string,
  state: LocalRepairStateV1,
): Promise<HumanRepairRetirementV1> {
  await assertNoRetainedVerificationForRetirement(state);
  const { decision, decisionSha256 } =
    await readValidatedRetirementDecision(state);
  const lifecycle = await readRepairLifecycle(state.lifecyclePath);
  let head = lifecycle.events.at(-1)?.state;
  if (head === undefined) {
    throw new Error('PP_REPAIR_LIFECYCLE_INVALID: lifecycle is empty.');
  }
  assertRetirementReconciliationWindow(head, state.state);
  const retirementEvent = lifecycle.events.find(
    (event) => event.state === 'retired_without_verification',
  );
  if (
    lifecycle.events.some((event) =>
      [
        'verification_started',
        'verification_passed',
        'verification_failed',
      ].includes(event.state),
    )
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retirement lifecycle contains a verification state.',
    );
  }
  if (retirementEvent === undefined && head !== 'human_approved') {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: a later lifecycle has no retained retirement transition.',
    );
  }
  if (
    retirementEvent !== undefined &&
    retirementEvent.payloadSha256 !==
      sha256CanonicalJson(
        retirementLifecyclePayload(decision, decisionSha256),
      )
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retirement lifecycle payload digest changed.',
    );
  }
  if (head === 'human_approved') {
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'retired_without_verification',
      retirementLifecyclePayload(decision, decisionSha256),
    );
    head = 'retired_without_verification';
  }
  if (head === 'retired_without_verification') {
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'evidence_saved',
      retirementEvidencePayload(decision, decisionSha256),
    );
    head = 'evidence_saved';
  }
  if (!['evidence_saved', 'cleanup_failed', 'cleanup_completed'].includes(head)) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_STATE_INVALID: lifecycle is not an unverified retirement.',
    );
  }
  const finalizedLifecycle = await readRepairLifecycle(state.lifecyclePath);
  const retirementIndex = finalizedLifecycle.events.findIndex(
    (event) => event.state === 'retired_without_verification',
  );
  const evidenceEvent = finalizedLifecycle.events[retirementIndex + 1];
  if (
    retirementIndex < 0 ||
    evidenceEvent?.state !== 'evidence_saved' ||
    evidenceEvent.payloadSha256 !==
      sha256CanonicalJson(retirementEvidencePayload(decision, decisionSha256))
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retirement evidence payload digest changed.',
    );
  }
  const cleanupEvent = finalizedLifecycle.events.find(
    (event, index) =>
      index > retirementIndex && event.state === 'cleanup_completed',
  );
  if (
    cleanupEvent !== undefined &&
    cleanupEvent.payloadSha256 !==
      sha256CanonicalJson({
        candidateRemoved: true,
        verificationRemoved: false,
      })
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retirement cleanup payload digest changed.',
    );
  }
  if (head === 'cleanup_completed') {
    await assertCandidateAbsentAfterRetirementCleanup(state);
  }
  const expectedFailure = retirementFailure(decision);
  const cleanupFailureEvent = finalizedLifecycle.events.find(
    (event, index) =>
      index > retirementIndex && event.state === 'cleanup_failed',
  );
  const retainedCleanupFailure =
    ['cleanup_failed', 'cleanup_completed'].includes(head) &&
    state.failure?.stage === 'cleanup';
  if (
    (cleanupFailureEvent === undefined && retainedCleanupFailure) ||
    (cleanupFailureEvent !== undefined && !retainedCleanupFailure) ||
    (retainedCleanupFailure &&
      cleanupFailureEvent !== undefined &&
      cleanupFailureEvent.payloadSha256 !==
        sha256CanonicalJson(state.failure))
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retained cleanup failure differs from its lifecycle payload.',
    );
  }
  if (
    state.failure !== null &&
    !retainedCleanupFailure &&
    canonicalJson(state.failure) !== canonicalJson(expectedFailure)
  ) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_EVIDENCE_INVALID: retained failure differs from the retirement decision.',
    );
  }
  if (!retainedCleanupFailure) {
    state.failure = expectedFailure;
  }
  state.state = head;
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
  return decision;
}

/**
 * Repairs the one intentional lifecycle-first persistence window at the end of
 * preparation. No lifecycle event is invented: the already-retained transition
 * is accepted only when the live candidate, immutable patch artifact, payload
 * digests, and every persisted patch field all still agree.
 */
async function reconcileAwaitingHumanReviewCrash(
  statePath: string,
  state: LocalRepairStateV1,
): Promise<boolean> {
  const lifecycle = await readRepairLifecycle(state.lifecyclePath);
  const awaitingEvent = lifecycle.events.at(-1);
  if (
    awaitingEvent?.state !== 'awaiting_human_review' ||
    state.state !== 'candidate_policy_accepted'
  ) {
    return false;
  }

  const candidateEvent = lifecycle.events.at(-2);
  if (
    lifecycle.repairId !== state.repairId ||
    candidateEvent?.state !== 'candidate_policy_accepted' ||
    state.patch === null ||
    state.provider === null ||
    state.providerFailure !== null ||
    state.failure !== null ||
    state.approvalSha256 !== null ||
    state.verificationWorktreePath !== null ||
    state.verificationReceiptPath !== null ||
    state.verificationReceiptSha256 !== null
  ) {
    reconciliationFailure(
      'retained preparation state is not the exact pre-review success state.',
    );
  }
  if (
    candidateEvent.payloadSha256 !== sha256CanonicalJson(state.patch) ||
    awaitingEvent.payloadSha256 !==
      sha256CanonicalJson({
        patchSha256: state.patch.sha256,
        patchBytes: state.patch.bytes,
        automaticApproval: false,
      })
  ) {
    reconciliationFailure(
      'candidate or awaiting-review lifecycle payload digest changed.',
    );
  }
  if (
    (await pathExists(state.approvalPath)) ||
    (await pathExists(path.join(state.artifactDirectory, 'failure.json'))) ||
    (await pathExists(state.codexHomePath)) ||
    (await pathExists(state.toolTempPath))
  ) {
    reconciliationFailure(
      'decision, failure, or isolated-provider runtime evidence appeared before review.',
    );
  }
  try {
    await assertUnchangedBase(state);
  } catch (error) {
    reconciliationFailure(
      'main checkout HEAD or shared Git refs changed after preparation.',
      error,
    );
  }

  await assertCanonicalRepairArtifact(state.artifactDirectory, 'directory');
  await assertCanonicalRepairArtifact(state.lifecyclePath, 'file');
  await assertCanonicalRepairArtifact(state.patchPath, 'file');
  const retainedPatchBytes = await readFile(state.patchPath);
  if (
    retainedPatchBytes.byteLength !== state.patch.bytes ||
    sha256Bytes(retainedPatchBytes) !== state.patch.sha256
  ) {
    reconciliationFailure(
      'retained patch size or digest differs from the candidate record.',
    );
  }

  let candidate: DisposableWorktree;
  try {
    candidate = await reopenDisposableWorktree(
      state.projectRoot,
      state.candidateWorktreePath,
    );
  } catch (error) {
    reconciliationFailure(
      'candidate worktree is missing, unregistered, or outside its retained boundary.',
      error,
    );
  }
  if (candidate.repository.baseHead !== state.baseCommit) {
    reconciliationFailure(
      'candidate worktree base differs from the retained base commit.',
    );
  }
  let validated: Awaited<ReturnType<typeof validateRepairDiff>>;
  try {
    validated = await validateRepairDiff(candidate);
  } catch (error) {
    reconciliationFailure(
      'candidate diff no longer satisfies the bounded repair policy.',
      error,
    );
  }
  if (validated.baseHead !== state.baseCommit) {
    reconciliationFailure(
      'validated candidate is no longer based on the retained commit.',
    );
  }

  const sourcePath = resolveRepositoryPath(
    candidate.worktreePath,
    'src/client/main.ts',
  );
  const regressionPath = resolveRepositoryPath(
    candidate.worktreePath,
    'tests/regression/initialization-order.spec.ts',
  );
  const [baseSource, sourceAfterSha256, regressionAfterSha256] =
    await Promise.all([
      runGit(candidate.worktreePath, [
        'show',
        `${state.baseCommit}:src/client/main.ts`,
      ]),
      fileSha256(sourcePath),
      fileSha256(regressionPath),
    ]);
  const expectedPatch = {
    sha256: validated.patchSha256,
    bytes: validated.patchBytes,
    additions: validated.addedLines,
    deletions: validated.deletedLines,
    changedFiles: [
      {
        path: 'src/client/main.ts' as const,
        status: 'modified' as const,
        beforeSha256: sha256Bytes(baseSource.stdout),
        afterSha256: sourceAfterSha256,
      },
      {
        path: 'tests/regression/initialization-order.spec.ts' as const,
        status: 'added' as const,
        beforeSha256: null,
        afterSha256: regressionAfterSha256,
      },
    ],
  };
  const expectedPatchBytes = Buffer.from(validated.patch, 'utf8');
  if (
    !retainedPatchBytes.equals(expectedPatchBytes)
  ) {
    reconciliationFailure(
      'retained patch bytes differ from the twice-validated live candidate.',
    );
  }
  if (
    canonicalJson(expectedPatch) !== canonicalJson(state.patch)
  ) {
    reconciliationFailure(
      'candidate record differs from the validated patch and file hashes.',
    );
  }

  state.state = 'awaiting_human_review';
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
  return true;
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
      : await reopenRetainedDisposableWorktree(
          state.projectRoot,
          verificationPath,
          {
            expectedAllocationId: repairWorktreeAllocationId(
              state.repairId,
              'verification',
            ),
            expectedBaseHead: state.baseCommit,
          },
        );
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
  if (retainedHead === 'cleanup_failed') {
    const cleanupLifecycle = await readRepairLifecycle(state.lifecyclePath);
    const cleanupEvent = cleanupLifecycle.events.at(-1);
    if (
      state.failure?.stage !== 'cleanup' ||
      cleanupEvent?.state !== 'cleanup_failed' ||
      cleanupEvent.payloadSha256 !== sha256CanonicalJson(state.failure)
    ) {
      throw new Error(
        'PP_REPAIR_CLEANUP_FAILURE_EVIDENCE_MISSING: retained cleanup failure is not available for a safe retry.',
      );
    }
  }
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
      state.failure = failure;
    } else if (state.failure?.stage !== 'cleanup') {
      throw new Error(
        'PP_REPAIR_CLEANUP_FAILURE_EVIDENCE_MISSING: retained cleanup failure is not available for a safe retry.',
        { cause: error },
      );
    }
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
    const bound = await readBoundRepairState(projectRoot, repairId);
    const statePath = bound.statePath;
    await reconcileAwaitingHumanReviewCrash(
      statePath,
      structuredClone(bound.state),
    );
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

export async function retireHumanApprovedRaceRepairInteractively(
  projectRoot: string,
  repairId: string,
): Promise<RepairRetirementResult> {
  const lock = await acquireRepairLock(projectRoot);
  try {
    const bound = await readBoundRepairState(projectRoot, repairId);
    const statePath = bound.statePath;
    const state = structuredClone(bound.state);
    let head = await lifecycleHead(state);
    const decisionPath = retirementDecisionPath(state);

    if (
      [
        'retired_without_verification',
        'evidence_saved',
        'cleanup_failed',
        'cleanup_completed',
      ].includes(head) &&
      (await pathExists(decisionPath))
    ) {
      const decision = await reconcileRetirementEvidence(statePath, state);
      head = await lifecycleHead(state);
      const cleanupState =
        head === 'cleanup_completed'
          ? 'cleanup_completed'
          : await recordCleanup(
              statePath,
              state,
              () => cleanupCandidate(state),
              false,
            );
      return deepFreeze({
        statePath,
        retirementPath: decisionPath,
        decision,
        cleanupState,
      });
    }

    if (
      head !== 'human_approved' ||
      state.state !== 'human_approved' ||
      state.failure !== null
    ) {
      throw new Error(
        'PP_REPAIR_RETIREMENT_STATE_INVALID: only an approved candidate whose verification never started may be retired.',
      );
    }
    await assertNoRetainedVerificationForRetirement(state);
    const approval = await assertRetainedApproval(state);
    const initialContext = await deriveRetirementContext(state);
    await assertRetainedCandidateMatchesPatch(state);
    const preexistingDecision = (await pathExists(decisionPath))
      ? await readValidatedRetirementDecision(state)
      : null;
    if (preexistingDecision !== null) {
      await assertRetirementObservedContext(
        state,
        preexistingDecision.decision,
      );
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'PP_REPAIR_RETIREMENT_TTY_REQUIRED: retiring an approved candidate requires a human interactive terminal.',
      );
    }
    process.stdout.write(
      [
        '',
        '=== Retire approved candidate without verification ===',
        `Repair ID: ${state.repairId}`,
        `Approved patch SHA-256: ${approval.patchSha256}`,
        `Retained base: ${state.baseCommit}`,
        `Current source: ${initialContext.repository.baseHead}`,
        'Verification verdict: NOT RUN',
        'Verification never started; no verification worktree is retained, and Playwright was not invoked.',
        'The approved patch and human decision will be preserved; only the disposable candidate checkout will be removed.',
        'This action cannot count as PASS. A fresh candidate must be prepared.',
        'To retire, type exactly:',
        expectedRetirementPhrase(state.repairId, approval.patchSha256),
        '',
      ].join('\n'),
    );
    const readline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let confirmation: string;
    try {
      confirmation = await readline.question('Decision: ');
    } finally {
      readline.close();
    }
    parseRetirementPhrase(
      confirmation,
      state.repairId,
      approval.patchSha256,
    );

    await assertRetainedApproval(state);
    await assertRetainedCandidateMatchesPatch(state);
    const finalContext = await deriveRetirementContext(state);
    if (
      finalContext.repository.baseHead !== initialContext.repository.baseHead ||
      finalContext.repository.headRef !== initialContext.repository.headRef ||
      finalContext.observedIntegrityRefStateSha256 !==
        initialContext.observedIntegrityRefStateSha256
    ) {
      throw new Error(
        'PP_REPAIR_RETIREMENT_CONTEXT_CHANGED: source integrity base changed while awaiting the human decision.',
      );
    }

    let decision: HumanRepairRetirementV1;
    let decisionSha256: string;
    if (preexistingDecision !== null) {
      await assertRetirementObservedContext(
        state,
        preexistingDecision.decision,
      );
      decision = preexistingDecision.decision;
      decisionSha256 = preexistingDecision.decisionSha256;
    } else {
      decision = humanRepairRetirementSchema.parse({
        schemaVersion: REPAIR_RETIREMENT_VERSION,
        repairId: state.repairId,
        disposition: 'retired_without_verification',
        verificationVerdict: 'not_run',
        verificationStarted: false,
        playwrightInvoked: false,
        verificationWorktreeRetainedAtDecision: false,
        verificationReceiptCreated: false,
        patchSha256: approval.patchSha256,
        patchBytes: approval.patchBytes,
        approvalSha256: state.approvalSha256,
        retainedBaseCommit: state.baseCommit,
        retainedBaseTree: state.baseTree,
        retainedHeadRef: state.baseHeadRef,
        observedCurrentCommit: finalContext.repository.baseHead,
        observedCurrentTree: finalContext.observedCurrentTree,
        observedCurrentHeadRef: finalContext.repository.headRef,
        retainedFullRefStateSha256: sha256CanonicalJson(state.baseRefState),
        retainedIntegrityRefStateSha256: sha256CanonicalJson(
          integrityRefState(state.baseRefState),
        ),
        observedIntegrityRefStateSha256:
          finalContext.observedIntegrityRefStateSha256,
        integrityRefPolicy: INTEGRITY_REF_POLICY,
        drift: finalContext.drift,
        candidateAudit: {
          detached: true,
          headMatchesRetainedBase: true,
          diffMatchesApprovedPatch: true,
          stagedChangeCount: 0,
          changedPaths: [
            'src/client/main.ts',
            'tests/regression/initialization-order.spec.ts',
          ],
        },
        reasonCode: REPAIR_RETIREMENT_REASON,
        nextAction: 'prepare_fresh_candidate',
        decidedAt: new Date().toISOString(),
        reviewer: 'human_operator',
        method: 'interactive_tty_exact_phrase',
        confirmationSha256: sha256Bytes(confirmation),
      });
      await writeNewJson(decisionPath, decision);
      decisionSha256 = await fileSha256(decisionPath);
    }
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'retired_without_verification',
      retirementLifecyclePayload(decision, decisionSha256),
    );
    state.state = 'retired_without_verification';
    state.failure = retirementFailure(decision);
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    await reconcileRetirementEvidence(statePath, state);
    const cleanupState = await recordCleanup(
      statePath,
      state,
      () => cleanupCandidate(state),
      false,
    );
    return deepFreeze({
      statePath,
      retirementPath: decisionPath,
      decision,
      cleanupState,
    });
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
    !equalIntegrityRefStates(repository.refState, state.baseRefState)
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
  const retainedLifecycle = await readRepairLifecycle(state.lifecyclePath);
  if (
    retainedLifecycle.events.some(
      (event) => event.state === 'retired_without_verification',
    )
  ) {
    return 'not_started';
  }

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
  let skipVerificationRecovery = false;
  try {
    const bound = await readBoundRepairState(input.projectRoot, input.repairId);
    statePath = bound.statePath;
    const state = structuredClone(bound.state);
    const retainedHead = await lifecycleHead(state);
    const retainedLifecycle = await readRepairLifecycle(state.lifecyclePath);
    if (
      retainedHead === 'human_approved' &&
      (await pathExists(retirementDecisionPath(state)))
    ) {
      skipVerificationRecovery = true;
      throw new Error(
        'PP_REPAIR_RETIREMENT_PENDING: a retained human retirement decision must be reconciled before any verification can start.',
      );
    }
    if (
      retainedLifecycle.events.some(
        (event) => event.state === 'retired_without_verification',
      )
    ) {
      skipVerificationRecovery = true;
      throw new Error(
        'PP_REPAIR_RETIRED_UNVERIFIED: this approved candidate was explicitly retired without Playwright verification; prepare a fresh candidate.',
      );
    }
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
    if (
      verification.repository.baseHead !== state.baseCommit ||
      verification.repository.headRef !== state.baseHeadRef ||
      !equalIntegrityRefStates(
        verification.repository.refState,
        state.baseRefState,
      )
    ) {
      throw new Error(
        'PP_REPAIR_VERIFICATION_BASE_CHANGED: fresh worktree was not captured from the retained source-integrity base.',
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
    await verifyDisposableWorktree(verification);

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
    if (statePath !== null && !skipVerificationRecovery) {
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
    if (
      head === 'awaiting_human_review' &&
      (await reconcileAwaitingHumanReviewCrash(statePath, state))
    ) {
      return (await readBoundRepairState(projectRoot, repairId)).state;
    }
    const retirementLifecycle = await readRepairLifecycle(state.lifecyclePath);
    if (
      retirementLifecycle.events.some(
        (event) => event.state === 'retired_without_verification',
      )
    ) {
      await reconcileRetirementEvidence(statePath, state);
      head = await lifecycleHead(state);
    }
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
