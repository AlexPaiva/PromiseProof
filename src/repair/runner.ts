import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  unlink,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';

import { deepFreeze } from '../investigation/immutable.js';
import {
  appendRepairLifecycle,
  fileSha256,
  sha256Bytes,
  writeLocalRepairState,
  writeNewBytes,
  writeNewJson,
  type LocalRepairStateV1,
  type RepairPatchRecord,
} from './artifact.js';
import {
  validateRepairDiff,
} from './diff-validator.js';
import { createIsolatedCommandEnvironment } from './command-environment.js';
import { deriveRaceRepairCandidateV1 } from './eligibility.js';
import {
  MILESTONE_03_TAG,
  readFrozenMilestone03Receipt,
  validateFrozenFoundation,
} from './foundation.js';
import {
  listGitStatus,
  resolveCleanRepository,
  resolveRepositoryPath,
  runGit,
} from './git.js';
import { buildRepairPrompt } from './prompt.js';
import {
  RepairProviderError,
  type RepairProvider,
  type RepairProviderResult,
  type SafeRepairProviderFailure,
} from './provider.js';
import {
  resolveNpmCliPath,
  runBoundedCommand,
  safeCommandReceipt,
  validateExpectedRedArtifacts,
  type BoundedCommandResult,
  type BoundedCommandRunner,
  type ExpectedRedValidation,
} from './verification.js';
import { cleanupIsolatedProviderRuntime } from './windows-sandbox.js';
import {
  cleanupDisposableWorktree,
  cleanupPersistedDisposableWorktreeIntent,
  materializeDisposableWorktree,
  planDisposableWorktree,
  repairWorktreeAllocationId,
  verifyDisposableWorktree,
  type DisposableWorktree,
} from './worktree.js';

export {
  MILESTONE_03_COMMIT,
  MILESTONE_03_RECEIPT_PATH,
  MILESTONE_03_TAG,
} from './foundation.js';

const REPAIR_RUNS_RELATIVE = ['test-results', 'repair-runs'] as const;
const LOCK_FILE = '.orchestrator.lock';
const BASELINE_OUTPUT_DIRECTORY = 'baseline-race-expected-red';
const BASELINE_COMMAND_TIMEOUT_MS = 3 * 60 * 1_000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1_000;
const CODEX_TIMEOUT_MS = 10 * 60 * 1_000;
const GENERATED_IGNORED_DIRECTORIES = [
  'node_modules',
  'dist',
  'test-results',
  'playwright-report',
  'blob-report',
  'coverage',
  '.vite',
  '.cache',
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SENSITIVE_ENVIRONMENT_NAME =
  /(?:api[_-]?key|secret|token|password|credential|private[_-]?key)/iu;

export interface RepairPreparationOptions {
  readonly projectRoot: string;
  readonly provider: RepairProvider;
  readonly apiKey: string;
  readonly commandRunner?: BoundedCommandRunner;
  readonly repairId?: string;
  readonly isolatedPort?: number;
}

export interface RepairPreparationResult {
  readonly repairId: string;
  readonly statePath: string;
  readonly artifactDirectory: string;
  readonly patchPath: string;
  readonly patchSha256: string;
  readonly patchBytes: number;
  readonly state: 'awaiting_human_review';
}

export interface RepairLock {
  readonly lockPath: string;
  readonly token: string;
  release(): Promise<void>;
}

export class RepairOrchestrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statePath: string | null = null,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'RepairOrchestrationError';
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new RepairOrchestrationError(
    code,
    message,
    null,
    cause === undefined ? undefined : { cause },
  );
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (
      !(
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'EEXIST'
      )
    ) {
      throw error;
    }
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    fail(
      'PP_REPAIR_ARTIFACT_ROOT_UNSAFE',
      'Repair artifact root must be a real directory.',
    );
  }
}

export async function resolveRepairRunsRoot(projectRoot: string): Promise<string> {
  const clean = await resolveCleanRepository(projectRoot);
  const testResults = path.join(clean.repoRoot, REPAIR_RUNS_RELATIVE[0]);
  const repairRuns = path.join(testResults, REPAIR_RUNS_RELATIVE[1]);
  await ensureRealDirectory(testResults);
  await ensureRealDirectory(repairRuns);
  return repairRuns;
}

export async function acquireRepairLock(projectRoot: string): Promise<RepairLock> {
  const repairRuns = await resolveRepairRunsRoot(projectRoot);
  const lockPath = path.join(repairRuns, LOCK_FILE);
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EEXIST'
    ) {
      fail(
        'PP_REPAIR_LOCK_HELD',
        `Another repair command owns ${lockPath}. Inspect the recorded PID before removing a stale lock.`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(
      `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      'utf8',
    );
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  await handle.close();

  let released = false;
  return Object.freeze({
    lockPath,
    token,
    release: async () => {
      if (released) {
        return;
      }
      const retained = JSON.parse(await readFile(lockPath, 'utf8')) as {
        token?: unknown;
      };
      if (retained.token !== token) {
        fail(
          'PP_REPAIR_LOCK_CHANGED',
          'Repair lock ownership changed; refusing to remove it.',
        );
      }
      await unlink(lockPath);
      released = true;
    },
  });
}

export async function recoverStaleRepairLock(
  projectRoot: string,
  options: { readonly minimumAgeMs?: number } = {},
): Promise<{ readonly lockPath: string; readonly deadPid: number }> {
  const minimumAgeMs = options.minimumAgeMs ?? 30_000;
  if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) {
    throw new TypeError('Stale lock minimum age must be a nonnegative integer.');
  }
  const repairRuns = await resolveRepairRunsRoot(projectRoot);
  const lockPath = path.join(repairRuns, LOCK_FILE);
  const info = await lstat(lockPath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) {
    fail(
      'PP_REPAIR_LOCK_UNSAFE',
      'Stale-lock recovery requires one real regular lock file.',
    );
  }
  const firstBody = await readFile(lockPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstBody) as unknown;
  } catch (error) {
    fail('PP_REPAIR_LOCK_MALFORMED', 'Repair lock is not valid JSON.', error);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(',') !== 'createdAt,pid,token'
  ) {
    fail('PP_REPAIR_LOCK_MALFORMED', 'Repair lock has unexpected fields.');
  }
  const lockRecord = parsed as {
    readonly token?: unknown;
    readonly pid?: unknown;
    readonly createdAt?: unknown;
  };
  const createdMs =
    typeof lockRecord.createdAt === 'string'
      ? Date.parse(lockRecord.createdAt)
      : Number.NaN;
  if (
    typeof lockRecord.token !== 'string' ||
    !UUID.test(lockRecord.token) ||
    typeof lockRecord.pid !== 'number' ||
    !Number.isSafeInteger(lockRecord.pid) ||
    lockRecord.pid <= 0 ||
    !Number.isFinite(createdMs)
  ) {
    fail('PP_REPAIR_LOCK_MALFORMED', 'Repair lock ownership record is invalid.');
  }
  const ageMs = Date.now() - createdMs;
  if (ageMs < minimumAgeMs) {
    fail(
      'PP_REPAIR_LOCK_TOO_NEW',
      'Repair lock is too recent for explicit stale-lock recovery.',
    );
  }
  let ownerAlive = true;
  try {
    process.kill(lockRecord.pid, 0);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ESRCH'
    ) {
      ownerAlive = false;
    } else if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EPERM'
    ) {
      ownerAlive = true;
    } else {
      throw error;
    }
  }
  if (ownerAlive) {
    fail(
      'PP_REPAIR_LOCK_OWNER_ALIVE',
      `Repair lock owner PID ${lockRecord.pid} is still alive.`,
    );
  }
  const [secondInfo, secondBody] = await Promise.all([
    lstat(lockPath),
    readFile(lockPath, 'utf8'),
  ]);
  if (
    secondInfo.isSymbolicLink() ||
    !secondInfo.isFile() ||
    secondInfo.nlink !== 1 ||
    secondInfo.size !== info.size ||
    secondInfo.mtimeMs !== info.mtimeMs ||
    secondBody !== firstBody
  ) {
    fail(
      'PP_REPAIR_LOCK_CHANGED',
      'Repair lock changed during stale-owner validation.',
    );
  }
  await unlink(lockPath);
  return deepFreeze({ lockPath, deadPid: lockRecord.pid });
}

export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPromise);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        rejectPromise(new Error('Could not allocate a loopback TCP port.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error === undefined) {
          resolvePromise(port);
        } else {
          rejectPromise(error);
        }
      });
    });
  });
}

function assertCommandSucceeded(result: BoundedCommandResult): void {
  if (
    result.exitCode !== 0 ||
    result.signal !== null ||
    result.timedOut ||
    result.outputLimitExceeded ||
    result.spawnError !== null
  ) {
    fail(
      'PP_REPAIR_BASELINE_COMMAND_FAILED',
      `${result.id} did not complete successfully.`,
    );
  }
}

async function resolveBaseTree(
  projectRoot: string,
  baseCommit: string,
): Promise<string> {
  const tree = (
    await runGit(projectRoot, ['rev-parse', '--verify', `${baseCommit}^{tree}`])
  ).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/u.test(tree)) {
    fail('PP_REPAIR_BASE_TREE_INVALID', 'Git returned an invalid base tree ID.');
  }
  return tree;
}

async function runBaseline(input: {
  worktree: DisposableWorktree;
  artifactDirectory: string;
  port: number;
  commandRunner: BoundedCommandRunner;
}): Promise<{
  install: ReturnType<typeof safeCommandReceipt>;
  verifier: ReturnType<typeof safeCommandReceipt>;
  validation: ExpectedRedValidation;
}> {
  const npmCli = await resolveNpmCliPath();
  const isolated = await createIsolatedCommandEnvironment(
    input.worktree.tempRoot,
    input.port,
  );
  try {
    const install = await input.commandRunner({
      id: 'candidate_install_dependencies',
      executable: process.execPath,
      args: [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: input.worktree.worktreePath,
      environment: isolated.environment,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    assertCommandSucceeded(install);

    const outputDirectory = path.join(
      input.artifactDirectory,
      BASELINE_OUTPUT_DIRECTORY,
    );
    const verifier = await input.commandRunner({
      id: 'baseline_race_expected_red',
      executable: process.execPath,
      args: [
        path.join(
          input.worktree.worktreePath,
          'node_modules',
          '@playwright',
          'test',
          'cli.js',
        ),
        'test',
        '--config=tests/contracts/playwright.config.ts',
        '--reporter=json',
        '--output',
        outputDirectory,
      ],
      cwd: input.worktree.worktreePath,
      environment: isolated.environment,
      timeoutMs: BASELINE_COMMAND_TIMEOUT_MS,
      outputDirectory,
    });
    const validation = await validateExpectedRedArtifacts({
      run: verifier,
      outputDirectory,
      projectRoot: input.worktree.worktreePath,
      expectedCode: 'PP_IDENTIFIABLE_EVENT_LEAK',
      expectedClause: 'no_identifiable_activity',
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    });
    return deepFreeze({
      install: safeCommandReceipt(install),
      verifier: safeCommandReceipt(verifier),
      validation,
    });
  } finally {
    await isolated.cleanup();
  }
}

async function discardGeneratedCandidateContent(
  worktree: DisposableWorktree,
): Promise<void> {
  for (const relative of GENERATED_IGNORED_DIRECTORIES) {
    const candidate = resolveRepositoryPath(worktree.worktreePath, relative);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      fail(
        'PP_REPAIR_GENERATED_PATH_UNSAFE',
        `Generated candidate path is not a real directory: ${relative}.`,
      );
    }
    await rm(candidate, { force: true, recursive: true, maxRetries: 3 });
  }
  const status = await listGitStatus(worktree.worktreePath, {
    includeIgnored: true,
  });
  const ignored = status.filter((entry) => entry.kind === 'ignored');
  if (ignored.length > 0) {
    fail(
      'PP_REPAIR_UNEXPECTED_IGNORED_CONTENT',
      `Candidate created ignored content outside disposable generated directories: ${ignored
        .map((entry) => entry.path)
        .join(', ')}.`,
    );
  }
}

async function removeIsolatedProviderRuntime(
  worktree: DisposableWorktree,
  state: LocalRepairStateV1,
): Promise<void> {
  await cleanupIsolatedProviderRuntime({
    tempRoot: worktree.tempRoot,
    codexHomePath: state.codexHomePath,
    toolTempPath: state.toolTempPath,
  });
}

function sensitiveRuntimeValues(apiKey: string): readonly string[] {
  const values = new Set<string>();
  if (apiKey.length >= 8) {
    values.add(apiKey);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      value.length >= 8 &&
      SENSITIVE_ENVIRONMENT_NAME.test(name)
    ) {
      values.add(value);
    }
  }
  return Object.freeze([...values]);
}

function assertPatchHasNoRuntimeSecret(
  patch: string,
  sensitiveValues: readonly string[],
): void {
  if (
    sensitiveValues.some((value) => patch.includes(value)) ||
    /(?:sk-[a-zA-Z0-9_-]{16,}|OPENAI_API_KEY\s*=|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/u.test(
      patch,
    )
  ) {
    fail(
      'PP_REPAIR_PATCH_SECRET_OBSERVED',
      'Candidate patch contains a protected runtime or credential-looking value.',
    );
  }
}

async function patchRecord(
  worktree: DisposableWorktree,
  validated: Awaited<ReturnType<typeof validateRepairDiff>>,
  sourceBeforeSha256: string,
): Promise<RepairPatchRecord> {
  const sourcePath = resolveRepositoryPath(
    worktree.worktreePath,
    'src/client/main.ts',
  );
  const regressionPath = resolveRepositoryPath(
    worktree.worktreePath,
    'tests/regression/initialization-order.spec.ts',
  );
  return {
    sha256: validated.patchSha256,
    bytes: validated.patchBytes,
    additions: validated.addedLines,
    deletions: validated.deletedLines,
    changedFiles: [
      {
        path: 'src/client/main.ts',
        status: 'modified',
        beforeSha256: sourceBeforeSha256,
        afterSha256: sha256Bytes(await readFile(sourcePath)),
      },
      {
        path: 'tests/regression/initialization-order.spec.ts',
        status: 'added',
        beforeSha256: null,
        afterSha256: sha256Bytes(await readFile(regressionPath)),
      },
    ],
  };
}

function safeFailure(
  stage: string,
  error: unknown,
  sensitiveValues: readonly string[],
): NonNullable<LocalRepairStateV1['failure']> {
  const provider = error instanceof RepairProviderError ? error.details : null;
  const diffCode =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null;
  const code = provider?.code ??
    (diffCode?.startsWith('PP_') === true
      ? diffCode
      : stage === 'candidate_policy'
        ? 'PP_REPAIR_CANDIDATE_REJECTED'
        : 'PP_REPAIR_PREPARATION_FAILED');
  let message = provider?.message ??
    (error instanceof Error ? error.message : 'Repair preparation failed.');
  for (const value of sensitiveValues) {
    message = message.replaceAll(value, '[REDACTED]');
  }
  return {
    stage,
    code: /^PP_[A-Z0-9_]+$/u.test(code)
      ? code
      : 'PP_REPAIR_PREPARATION_FAILED',
    message: message.slice(0, 1_000),
    recordedAt: new Date().toISOString(),
  };
}

async function cleanupAfterFailure(
  statePath: string,
  state: LocalRepairStateV1,
  worktree: DisposableWorktree | null,
  error: unknown,
  stage: string,
  sensitiveValues: readonly string[],
): Promise<void> {
  const failure = safeFailure(stage, error, sensitiveValues);
  state.failure = failure;
  if (error instanceof RepairProviderError) {
    state.providerFailure = error.details;
  }
  await writeNewJson(path.join(state.artifactDirectory, 'failure.json'), failure);
  await appendRepairLifecycle(
    state.lifecyclePath,
    state.repairId,
    'evidence_saved',
    failure,
  );
  state.state = 'evidence_saved';
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
  try {
    if (worktree === null) {
      await cleanupPersistedDisposableWorktreeIntent(
        state.projectRoot,
        state.candidateWorktreePath,
      );
    } else {
      await removeIsolatedProviderRuntime(worktree, state);
      await cleanupDisposableWorktree(worktree);
    }
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'cleanup_completed',
      { candidateWorktreeRemoved: true },
    );
    state.state = 'cleanup_completed';
  } catch (cleanupError) {
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      'cleanup_failed',
      safeFailure('cleanup', cleanupError, sensitiveValues),
    );
    state.state = 'cleanup_failed';
  }
  state.updatedAt = new Date().toISOString();
  await writeLocalRepairState(statePath, state);
}

export async function prepareRaceRepair(
  options: RepairPreparationOptions,
): Promise<RepairPreparationResult> {
  const lock = await acquireRepairLock(options.projectRoot);
  try {
    return await prepareRaceRepairLocked(options);
  } finally {
    await lock.release();
  }
}

async function prepareRaceRepairLocked(
  options: RepairPreparationOptions,
): Promise<RepairPreparationResult> {
  const repository = await resolveCleanRepository(options.projectRoot);
  const baseTree = await resolveBaseTree(
    repository.repoRoot,
    repository.baseHead,
  );
  const frozenFoundation = await validateFrozenFoundation({
    projectRoot: repository.repoRoot,
    baseCommit: repository.baseHead,
    baseTree,
  });
  const eligibility = deriveRaceRepairCandidateV1(
    await readFrozenMilestone03Receipt(
    repository.repoRoot,
    ),
  );
  const repairId = options.repairId ?? randomUUID();
  if (!UUID.test(repairId)) {
    fail('PP_REPAIR_ID_INVALID', 'Repair ID must be a UUID.');
  }
  const port = options.isolatedPort ?? (await allocateLoopbackPort());
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
    fail('PP_REPAIR_PORT_INVALID', 'Repair baseline requires an unprivileged port.');
  }
  const commandRunner = options.commandRunner ?? runBoundedCommand;
  const { prompt, promptEnvelopeSha256 } = buildRepairPrompt(
    eligibility,
    repairId,
  );
  const sensitiveValues = sensitiveRuntimeValues(options.apiKey);

  let worktree: DisposableWorktree | null = null;
  let state: LocalRepairStateV1 | null = null;
  let statePath: string | null = null;
  let statePersisted = false;
  let plannedCandidatePath: string | null = null;
  let stage = 'worktree_creation';
  try {
    const worktreePlan = await planDisposableWorktree(repository.repoRoot, {
      allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
    });
    plannedCandidatePath = worktreePlan.worktreePath;
    const repairRuns = path.join(
      repository.repoRoot,
      ...REPAIR_RUNS_RELATIVE,
    );
    const artifactDirectory = path.join(repairRuns, repairId);
    await mkdir(artifactDirectory, { recursive: false, mode: 0o700 });
    const artifactInfo = await lstat(artifactDirectory);
    if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
      fail(
        'PP_REPAIR_ARTIFACT_ROOT_UNSAFE',
        'Repair-specific artifact directory is unsafe.',
      );
    }
    statePath = path.join(artifactDirectory, 'state.json');
    const createdAt = new Date().toISOString();
    state = {
      schemaVersion: 'promiseproof.repair-local-state.v1',
      repairId,
      state: 'created',
      createdAt,
      updatedAt: createdAt,
      projectRoot: repository.repoRoot,
      artifactDirectory,
      lifecyclePath: path.join(artifactDirectory, 'lifecycle.json'),
      patchPath: path.join(artifactDirectory, 'candidate.patch'),
      approvalPath: path.join(artifactDirectory, 'human-decision.json'),
      candidateWorktreePath: worktreePlan.worktreePath,
      verificationWorktreePath: null,
      codexHomePath: path.join(worktreePlan.tempRoot, 'codex-home'),
      toolTempPath: path.join(worktreePlan.tempRoot, 'tool-temp'),
      baseCommit: repository.baseHead,
      baseTree,
      baseHeadRef: repository.headRef,
      baseRefState: repository.refState,
      milestoneTag: MILESTONE_03_TAG,
      frozenFoundation,
      eligibility,
      promptEnvelopeSha256,
      provider: null,
      providerFailure: null,
      failure: null,
      patch: null,
      approvalSha256: null,
      verificationReceiptPath: null,
      verificationReceiptSha256: null,
    };
    await appendRepairLifecycle(state.lifecyclePath, repairId, 'created', {
      baseCommit: state.baseCommit,
      baseTree: state.baseTree,
      frozenFoundation,
      promptEnvelopeSha256,
      eligibility,
      candidateWorktreePath: worktreePlan.worktreePath,
    });
    await writeLocalRepairState(statePath, state);
    statePersisted = true;

    worktree = await materializeDisposableWorktree(worktreePlan);
    if (
      worktree.repository.baseHead !== repository.baseHead ||
      worktree.repository.headRef !== repository.headRef
    ) {
      fail(
        'PP_REPAIR_BASE_CHANGED',
        'Repository base changed while the candidate worktree was created.',
      );
    }
    const sourceBeforeSha256 = sha256Bytes(
      await readFile(
        resolveRepositoryPath(worktree.worktreePath, 'src/client/main.ts'),
      ),
    );

    stage = 'baseline';
    const baseline = await runBaseline({
      worktree,
      artifactDirectory,
      port,
      commandRunner,
    });
    await appendRepairLifecycle(
      state.lifecyclePath,
      repairId,
      'baseline_verified',
      baseline,
    );
    state.state = 'baseline_verified';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    stage = 'codex';
    let providerResult: RepairProviderResult;
    try {
      providerResult = await options.provider.prepareRepair({
        worktreePath: worktree.worktreePath,
        codexHomePath: state.codexHomePath,
        toolTempPath: state.toolTempPath,
        prompt,
        apiKey: options.apiKey,
        timeoutMs: CODEX_TIMEOUT_MS,
        sensitiveValues,
      });
    } catch (error) {
      if (error instanceof RepairProviderError) {
        state.providerFailure = error.details;
      }
      throw error;
    }
    state.provider = providerResult;
    await removeIsolatedProviderRuntime(worktree, state);
    await appendRepairLifecycle(
      state.lifecyclePath,
      repairId,
      'codex_completed',
      { provider: providerResult, isolatedRuntimeRemoved: true },
    );
    state.state = 'codex_completed';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    stage = 'candidate_policy';
    await discardGeneratedCandidateContent(worktree);
    await verifyDisposableWorktree(worktree);
    const validated = await validateRepairDiff(worktree);
    assertPatchHasNoRuntimeSecret(validated.patch, sensitiveValues);
    const retainedPatch = await patchRecord(
      worktree,
      validated,
      sourceBeforeSha256,
    );
    await writeNewBytes(state.patchPath, validated.patch);
    if (
      (await fileSha256(state.patchPath)) !== validated.patchSha256 ||
      (await readFile(state.patchPath)).byteLength !== validated.patchBytes
    ) {
      fail(
        'PP_REPAIR_PATCH_RETENTION_FAILED',
        'Retained patch differs from the twice-inspected candidate diff.',
      );
    }
    state.patch = retainedPatch;
    await appendRepairLifecycle(
      state.lifecyclePath,
      repairId,
      'candidate_policy_accepted',
      retainedPatch,
    );
    state.state = 'candidate_policy_accepted';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);

    await appendRepairLifecycle(
      state.lifecyclePath,
      repairId,
      'awaiting_human_review',
      {
        patchSha256: retainedPatch.sha256,
        patchBytes: retainedPatch.bytes,
        automaticApproval: false,
      },
    );
    state.state = 'awaiting_human_review';
    state.updatedAt = new Date().toISOString();
    await writeLocalRepairState(statePath, state);
    return deepFreeze({
      repairId,
      statePath,
      artifactDirectory,
      patchPath: state.patchPath,
      patchSha256: retainedPatch.sha256,
      patchBytes: retainedPatch.bytes,
      state: 'awaiting_human_review' as const,
    });
  } catch (error) {
    if (statePersisted && state !== null && statePath !== null) {
      try {
        await cleanupAfterFailure(
          statePath,
          state,
          worktree,
          error,
          stage,
          sensitiveValues,
        );
      } catch (retentionError) {
        throw new AggregateError(
          [error, retentionError],
          'Repair preparation failed and its failure evidence could not be finalized.',
        );
      }
      throw new RepairOrchestrationError(
        safeFailure(stage, error, sensitiveValues).code,
        safeFailure(stage, error, sensitiveValues).message,
        statePath,
        { cause: error },
      );
    }
    if (worktree !== null) {
      await cleanupDisposableWorktree(worktree).catch(() => undefined);
    } else if (plannedCandidatePath !== null) {
      await cleanupPersistedDisposableWorktreeIntent(
        repository.repoRoot,
        plannedCandidatePath,
      ).catch(() => undefined);
    }
    throw error;
  }
}

export function providerFailureFromState(
  state: LocalRepairStateV1,
): SafeRepairProviderFailure | null {
  return state.providerFailure;
}
