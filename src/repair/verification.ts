import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { deepFreeze } from '../investigation/immutable.js';
import { promiseEvidenceSchema } from '../investigation/schemas.js';
import { evaluatePromise } from '../shared/evaluator.js';
import {
  humanRepairDecisionSchema,
  type HumanRepairDecisionV1,
} from './approval.js';
import { sha256Bytes } from './artifact.js';
import { createIsolatedCommandEnvironment } from './command-environment.js';
import {
  REPAIR_ADDED_REGRESSION_PATH,
  REPAIR_MODIFIED_SOURCE_PATH,
  validateRepairDiff,
} from './diff-validator.js';
import { isPathInside, listGitStatus, runGit } from './git.js';
import {
  verifyDisposableWorktree,
  type DisposableWorktree,
} from './worktree.js';

export const REPAIR_VERIFICATION_RECEIPT_VERSION =
  'promiseproof.repair-verification.v1' as const;
export const REPAIR_VERIFICATION_FAILURE_VERSION =
  'promiseproof.repair-verification-failure.v1' as const;

const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const STAGE_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const PP_CODE_PATTERN = /\bPP_[A-Z0-9_]+\b/gu;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const PLAYWRIGHT_TIMEOUT_MS = 3 * 60 * 1000;
const REPORT_CLOCK_TOLERANCE_MS = 2_000;
const TERMINATION_GRACE_MS = 10_000;

export type VerificationStageId =
  | 'install_dependencies'
  | 'build'
  | 'race_off_single'
  | 'race_on_single'
  | 'race_off_repeat_5'
  | 'race_on_repeat_5'
  | 'propagation_expected_red'
  | 'propagation_green'
  | 'startup_regression';

export interface BoundedCommandSpec {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes?: number;
  /** Present for Playwright stages so injected offline runners can write fixtures. */
  readonly outputDirectory?: string;
}

export interface BoundedCommandResult {
  readonly id: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly spawnError: string | null;
}

export type BoundedCommandRunner = (
  spec: BoundedCommandSpec,
) => Promise<BoundedCommandResult>;

export interface SafeCommandReceipt {
  readonly id: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
  readonly spawnError: string | null;
  readonly stdoutBytes: number;
  readonly stdoutSha256: string;
  readonly stderrBytes: number;
  readonly stderrSha256: string;
}

export interface ArtifactManifestEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface PlaywrightReportSummary {
  readonly expected: number;
  readonly unexpected: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly discoveredTests: number;
  readonly files: readonly string[];
  readonly statuses: Readonly<Record<string, number>>;
}

export interface ScenarioEvidenceSummary {
  readonly scenario: 'off' | 'on';
  readonly runId: string;
  readonly userId: string;
  readonly verdict: 'pass' | 'fail';
  readonly violationCodes: readonly string[];
  readonly passedClauseIds: readonly string[];
  readonly failedClauseIds: readonly string[];
  readonly identifiableActivityRequests: number;
  readonly identifiableActivityReceipts: number;
  readonly recommendationSource: 'contextual' | 'behavioral';
  readonly recommendationItemCount: number;
  readonly uiPreference: 'off' | 'on';
  readonly storagePreference: 'off' | 'on' | null;
  readonly backendPreference: 'off' | 'on';
  readonly reloadObserved: boolean;
  readonly browserErrorCount: number;
  readonly artifactSha256: string;
}

export interface PassingScenarioValidation {
  readonly report: PlaywrightReportSummary;
  readonly evidence: readonly ScenarioEvidenceSummary[];
}

export interface ExpectedRedValidation {
  readonly report: PlaywrightReportSummary;
  readonly evidence: ScenarioEvidenceSummary;
  readonly evidencePath: string;
  readonly artifactManifest: readonly ArtifactManifestEntry[];
}

export interface RepairVerificationReceiptV1 {
  readonly schemaVersion: typeof REPAIR_VERIFICATION_RECEIPT_VERSION;
  readonly repairId: string;
  readonly verdict: 'pass';
  readonly baseCommit: string;
  readonly approvedPatchSha256: string;
  readonly patchBytes: number;
  readonly verificationWorktreeFresh: true;
  readonly candidateAndVerificationWorktreesDistinct: true;
  readonly patchAppliedByExactDigest: true;
  readonly patchUnchangedAfterVerification: true;
  readonly isolatedPort: number;
  readonly baseUrl: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly commands: readonly SafeCommandReceipt[];
  readonly checks: {
    readonly build: true;
    readonly raceOffSingle: ScenarioEvidenceSummary;
    readonly raceOnSingle: ScenarioEvidenceSummary;
    readonly raceOffFive: readonly ScenarioEvidenceSummary[];
    readonly raceOnFive: readonly ScenarioEvidenceSummary[];
    readonly propagationExpectedRed: ScenarioEvidenceSummary;
    readonly propagationGreenTestCount: 6;
    readonly startupRegressionTestCount: 1;
  };
  readonly retainedArtifacts: readonly ArtifactManifestEntry[];
}

export interface VerifyApprovedRepairOptions {
  readonly expectedRepairId: string;
  readonly verificationWorktree: DisposableWorktree;
  readonly candidateWorktreePath: string;
  readonly retainedPatchPath: string;
  readonly expectedPatchBytes: number;
  readonly expectedBaseCommit: string;
  readonly approval: HumanRepairDecisionV1;
  /** Must not exist and must be outside both disposable worktrees. */
  readonly verificationArtifactRoot: string;
  readonly isolatedPort: number;
  readonly commandRunner?: BoundedCommandRunner;
}

export class RepairVerificationError extends Error {
  readonly code: string;
  readonly failureReceiptPath: string | null;

  constructor(
    code: string,
    message: string,
    options: { readonly cause?: unknown; readonly failureReceiptPath?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RepairVerificationError';
    this.code = code;
    this.failureReceiptPath = options.failureReceiptPath ?? null;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new RepairVerificationError(code, message, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return fail('malformed_artifact', `${label} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail('malformed_artifact', `${label} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    return fail('malformed_artifact', `${label} must be a string.`);
  }
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    return fail('malformed_artifact', `${label} must be a boolean.`);
  }
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return fail(
      'malformed_artifact',
      `${label} must be a nonnegative safe integer.`,
    );
  }
  return value;
}

function requireLiteral<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(
      'malformed_artifact',
      `${label} must be one of: ${allowed.join(', ')}.`,
    );
  }
  return value as T;
}

function uniquePromiseProofCodes(value: string): readonly string[] {
  return Object.freeze([...new Set(value.match(PP_CODE_PATTERN) ?? [])].sort());
}

function outputHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function terminateChild(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    const killer = spawn(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    );
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

export async function runBoundedCommand(
  spec: BoundedCommandSpec,
): Promise<BoundedCommandResult> {
  if (!STAGE_ID.test(spec.id)) {
    throw new TypeError('Bounded command id is invalid.');
  }
  if (!path.isAbsolute(spec.cwd) || spec.executable.length === 0) {
    throw new TypeError('Bounded command requires an absolute cwd and executable.');
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs <= 0) {
    throw new TypeError('Bounded command timeout must be a positive safe integer.');
  }
  const maxOutputBytes = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new TypeError('Bounded command output cap must be a positive safe integer.');
  }

  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  return await new Promise<BoundedCommandResult>((resolvePromise) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let spawnError: string | null = null;
    let settled = false;
    let terminationDeadline: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      env: spec.environment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (terminationDeadline !== null) {
        clearTimeout(terminationDeadline);
      }
      const completed = Date.now();
      resolvePromise(
        deepFreeze({
          id: spec.id,
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          startedAt,
          completedAt: new Date(completed).toISOString(),
          durationMs: completed - start,
          timedOut,
          outputLimitExceeded,
          spawnError,
        }),
      );
    };
    const requestTermination = (): void => {
      terminateChild(child);
      if (terminationDeadline !== null) {
        return;
      }
      terminationDeadline = setTimeout(() => {
        child.kill('SIGKILL');
        spawnError ??=
          'Process did not close within the bounded termination grace period.';
        finish(null, null);
      }, TERMINATION_GRACE_MS);
      terminationDeadline.unref();
    };
    const capture = (target: Buffer[], chunk: Buffer | string): void => {
      if (settled || outputLimitExceeded) {
        return;
      }
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      totalBytes += bytes.byteLength;
      if (totalBytes > maxOutputBytes) {
        outputLimitExceeded = true;
        requestTermination();
        return;
      }
      target.push(bytes);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.on('error', (error) => {
      spawnError = error.message;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, spec.timeoutMs);
    timeout.unref();

    child.on('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
}

export function safeCommandReceipt(
  result: BoundedCommandResult,
): SafeCommandReceipt {
  return deepFreeze({
    id: result.id,
    exitCode: result.exitCode,
    signal: result.signal,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    durationMs: result.durationMs,
    timedOut: result.timedOut,
    outputLimitExceeded: result.outputLimitExceeded,
    spawnError: result.spawnError,
    stdoutBytes: Buffer.byteLength(result.stdout, 'utf8'),
    stdoutSha256: outputHash(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr, 'utf8'),
    stderrSha256: outputHash(result.stderr),
  });
}

function assertRunnableResult(
  run: BoundedCommandResult,
  expectedExitCode: number,
): void {
  if (run.spawnError !== null) {
    fail('command_spawn_failed', `${run.id} could not start: ${run.spawnError}`);
  }
  if (run.timedOut) {
    fail('command_timed_out', `${run.id} exceeded its timeout.`);
  }
  if (run.outputLimitExceeded) {
    fail('command_output_limit', `${run.id} exceeded its output limit.`);
  }
  if (run.signal !== null) {
    fail('command_signaled', `${run.id} ended with signal ${run.signal}.`);
  }
  if (run.exitCode !== expectedExitCode) {
    fail(
      'unexpected_exit_code',
      `${run.id} exited ${String(run.exitCode)}; expected ${expectedExitCode}.`,
    );
  }
}

function reportedFile(
  projectRoot: string,
  reporterRoot: string,
  value: string,
): string {
  const root = path.resolve(projectRoot);
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(reporterRoot, value);
  const relative = path.relative(root, absolute);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail('unexpected_test_file', `Playwright reported a file outside the worktree: ${value}`);
  }
  return relative.split(path.sep).join('/');
}

interface ReporterTest {
  readonly expectedStatus: string;
  readonly status: string;
  readonly results: readonly { readonly status: string }[];
}

interface ReporterSpec {
  readonly file: string;
  readonly tests: readonly ReporterTest[];
}

function collectReporterSpecs(value: unknown, output: ReporterSpec[]): void {
  const suite = requireRecord(value, 'Playwright suite');
  for (const rawSpec of requireArray(suite.specs, 'Playwright suite.specs')) {
    const spec = requireRecord(rawSpec, 'Playwright spec');
    const tests = requireArray(spec.tests, 'Playwright spec.tests').map((rawTest) => {
      const test = requireRecord(rawTest, 'Playwright test');
      const results = requireArray(test.results, 'Playwright test.results').map(
        (rawResult) => {
          const result = requireRecord(rawResult, 'Playwright result');
          return { status: requireString(result.status, 'Playwright result.status') };
        },
      );
      if (results.length !== 1) {
        fail('unexpected_test_attempts', 'Each no-retry Playwright test must have one result.');
      }
      return {
        expectedStatus: requireString(
          test.expectedStatus,
          'Playwright test.expectedStatus',
        ),
        status: requireString(test.status, 'Playwright test.status'),
        results,
      };
    });
    if (tests.length === 0) {
      fail('zero_tests', 'A Playwright spec contained no executed tests.');
    }
    output.push({
      file: requireString(spec.file, 'Playwright spec.file'),
      tests,
    });
  }
  const childSuites = suite.suites;
  if (childSuites !== undefined) {
    for (const child of requireArray(childSuites, 'Playwright suite.suites')) {
      collectReporterSpecs(child, output);
    }
  }
}

export function validatePlaywrightJsonReport(input: {
  readonly rawReport: string;
  readonly run: BoundedCommandResult;
  readonly projectRoot: string;
  readonly expectedTestCount: number;
  readonly expectedFiles: readonly string[];
  readonly expectedOutcome: 'passed' | 'failed';
}): PlaywrightReportSummary {
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawReport) as unknown;
  } catch (error) {
    return fail('malformed_playwright_report', 'Playwright JSON report is malformed.', error);
  }
  const report = requireRecord(raw, 'Playwright report');
  const config = requireRecord(report.config, 'Playwright report.config');
  const reporterRoot = path.resolve(
    requireString(config.rootDir, 'Playwright report.config.rootDir'),
  );
  const projectRoot = path.resolve(input.projectRoot);
  if (
    reporterRoot !== projectRoot &&
    !isPathInside(projectRoot, reporterRoot)
  ) {
    fail(
      'unexpected_report_root',
      'Playwright reporter root must stay inside the verification worktree.',
    );
  }
  const topErrors = requireArray(report.errors, 'Playwright report.errors');
  if (topErrors.length !== 0) {
    fail('playwright_top_level_error', 'Playwright reported a top-level runner error.');
  }
  const stats = requireRecord(report.stats, 'Playwright report.stats');
  const expected = requireNumber(stats.expected, 'Playwright stats.expected');
  const unexpected = requireNumber(stats.unexpected, 'Playwright stats.unexpected');
  const flaky = requireNumber(stats.flaky, 'Playwright stats.flaky');
  const skipped = requireNumber(stats.skipped, 'Playwright stats.skipped');
  const startTime = Date.parse(requireString(stats.startTime, 'Playwright stats.startTime'));
  const runStart = Date.parse(input.run.startedAt);
  const runEnd = Date.parse(input.run.completedAt);
  if (
    !Number.isFinite(startTime) ||
    !Number.isFinite(runStart) ||
    !Number.isFinite(runEnd) ||
    startTime < runStart - REPORT_CLOCK_TOLERANCE_MS ||
    startTime > runEnd + REPORT_CLOCK_TOLERANCE_MS
  ) {
    fail('stale_playwright_report', 'Playwright report timing is outside the command window.');
  }

  const specs: ReporterSpec[] = [];
  for (const suite of requireArray(report.suites, 'Playwright report.suites')) {
    collectReporterSpecs(suite, specs);
  }
  const tests = specs.flatMap((spec) => spec.tests);
  if (tests.length !== input.expectedTestCount || tests.length === 0) {
    fail(
      'unexpected_test_count',
      `Playwright executed ${tests.length} test(s); expected ${input.expectedTestCount}.`,
    );
  }
  const files = [
    ...new Set(
      specs.map((spec) =>
        reportedFile(input.projectRoot, reporterRoot, spec.file),
      ),
    ),
  ].sort();
  const expectedFiles = [...input.expectedFiles].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
    fail(
      'unexpected_test_file',
      `Playwright files differ: observed ${files.join(', ') || 'none'}.`,
    );
  }

  const statuses: Record<string, number> = {};
  for (const test of tests) {
    statuses[test.status] = (statuses[test.status] ?? 0) + 1;
    if (test.expectedStatus !== 'passed') {
      fail('altered_test_expectation', 'A Playwright test did not expect a passing result.');
    }
    const resultStatus = test.results[0]?.status;
    if (
      input.expectedOutcome === 'passed'
        ? test.status !== 'expected' || resultStatus !== 'passed'
        : test.status !== 'unexpected' || resultStatus !== 'failed'
    ) {
      fail('unexpected_test_status', 'Playwright test/result status did not match the required outcome.');
    }
  }

  if (
    input.expectedOutcome === 'passed'
      ? expected !== input.expectedTestCount || unexpected !== 0
      : expected !== 0 || unexpected !== input.expectedTestCount
  ) {
    fail('unexpected_report_stats', 'Playwright expected/unexpected totals are incorrect.');
  }
  if (flaky !== 0 || skipped !== 0) {
    fail('non_clean_report_stats', 'Flaky or skipped tests are forbidden in repair verification.');
  }

  return deepFreeze({
    expected,
    unexpected,
    flaky,
    skipped,
    discoveredTests: tests.length,
    files,
    statuses,
  });
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        fail('artifact_symbolic_link', `Verification artifact is a symbolic link: ${entryPath}`);
      }
      return entry.isDirectory() ? await listFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat().sort();
}

export async function buildArtifactManifest(
  directory: string,
): Promise<readonly ArtifactManifestEntry[]> {
  const root = await realpath(directory);
  const files = await listFiles(root);
  const manifest = await Promise.all(
    files.map(async (filePath) => {
      const info = await stat(filePath);
      if (!info.isFile()) {
        fail('artifact_not_regular_file', `Artifact is not a regular file: ${filePath}`);
      }
      const relative = path.relative(root, filePath).split(path.sep).join('/');
      return {
        path: relative,
        bytes: info.size,
        sha256: sha256Bytes(await readFile(filePath)),
      };
    }),
  );
  return deepFreeze(manifest);
}

async function readLastRun(
  outputDirectory: string,
  expectedStatus: 'passed' | 'failed',
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(path.join(outputDirectory, '.last-run.json'), 'utf8'),
    ) as unknown;
  } catch (error) {
    return fail('malformed_last_run', 'Playwright .last-run.json is missing or malformed.', error);
  }
  const lastRun = requireRecord(raw, 'Playwright .last-run.json');
  if (lastRun.status !== expectedStatus) {
    fail('unexpected_last_run_status', `Expected last-run ${expectedStatus}.`);
  }
  const failedTests = requireArray(lastRun.failedTests, 'Playwright failedTests');
  const expectedFailures = expectedStatus === 'failed' ? 1 : 0;
  if (failedTests.length !== expectedFailures) {
    fail(
      'unexpected_failed_test_count',
      `Expected ${expectedFailures} failed Playwright test id(s).`,
    );
  }
}

async function assertArtifactFreshness(
  outputDirectory: string,
  run: BoundedCommandResult,
): Promise<void> {
  const runStart = Date.parse(run.startedAt);
  const runEnd = Date.parse(run.completedAt);
  if (!Number.isFinite(runStart) || !Number.isFinite(runEnd) || runEnd < runStart) {
    fail('invalid_command_timing', 'Command timing cannot establish artifact freshness.');
  }
  let files: string[];
  try {
    files = await listFiles(outputDirectory);
  } catch (error) {
    return fail(
      'missing_output_directory',
      'Playwright output directory is missing or unreadable.',
      error,
    );
  }
  if (files.length === 0) {
    fail('empty_output_directory', 'Playwright output directory contains no artifacts.');
  }
  for (const filePath of files) {
    const info = await stat(filePath);
    if (
      info.mtimeMs < runStart - REPORT_CLOCK_TOLERANCE_MS ||
      info.mtimeMs > runEnd + REPORT_CLOCK_TOLERANCE_MS
    ) {
      fail(
        'stale_playwright_artifact',
        `Playwright artifact timestamp is outside the command window: ${path.basename(filePath)}.`,
      );
    }
  }
}

function matchingRecommendationReceipt(
  evidence: Record<string, unknown>,
  source: 'contextual' | 'behavioral',
  userId: string,
  itemIds: readonly unknown[],
): boolean {
  const backend = requireRecord(evidence.backend, 'evidence.backend');
  return requireArray(
    backend.recommendationReceipts,
    'evidence.backend.recommendationReceipts',
  ).some((rawReceipt) => {
    const receipt = requireRecord(rawReceipt, 'recommendation receipt');
    if (receipt.source !== source) {
      return false;
    }
    if (source === 'contextual' ? receipt.userId !== undefined : receipt.userId !== userId) {
      return false;
    }
    const items = requireArray(receipt.items, 'recommendation receipt.items').map(
      (rawItem) => requireRecord(rawItem, 'recommendation item').id,
    );
    return JSON.stringify(items) === JSON.stringify(itemIds);
  });
}

function parseScenarioEvidence(
  raw: unknown,
  artifactSha256: string,
): { readonly artifact: Record<string, unknown>; readonly summary: ScenarioEvidenceSummary } {
  const artifact = requireRecord(raw, 'normalized evidence');
  if (artifact.schemaVersion !== 2) {
    fail('malformed_artifact', 'Normalized evidence schemaVersion must equal 2.');
  }
  let canonicalEvidence: ReturnType<typeof promiseEvidenceSchema.parse>;
  try {
    canonicalEvidence = promiseEvidenceSchema.parse(artifact.evidence);
  } catch (error) {
    return fail(
      'malformed_artifact',
      'Normalized evidence does not satisfy the canonical runtime schema.',
      error,
    );
  }
  const evidence = requireRecord(artifact.evidence, 'evidence');
  const evaluation = requireRecord(artifact.evaluation, 'evaluation');
  if (!isDeepStrictEqual(evaluation, evaluatePromise(canonicalEvidence))) {
    fail(
      'evaluation_mismatch',
      'Retained evaluation differs from a fresh deterministic evaluator result.',
    );
  }
  const observations = requireRecord(artifact.observations, 'observations');
  const scenario = requireLiteral(evidence.scenario, ['off', 'on'] as const, 'evidence.scenario');
  const runId = requireString(evidence.runId, 'evidence.runId');
  const userId = requireString(evidence.userId, 'evidence.userId');
  if (runId.length === 0 || userId.length === 0) {
    fail('malformed_artifact', 'Evidence runId and userId must be nonempty.');
  }
  const verdict = requireLiteral(
    evaluation.verdict,
    ['pass', 'fail'] as const,
    'evaluation.verdict',
  );
  const violations = requireArray(evaluation.violations, 'evaluation.violations').map(
    (rawViolation) => {
      const violation = requireRecord(rawViolation, 'evaluation violation');
      return {
        code: requireString(violation.code, 'violation.code'),
        clause: requireString(violation.clause, 'violation.clause'),
      };
    },
  );
  const clauses = requireArray(evaluation.clauses, 'evaluation.clauses').map(
    (rawClause) => {
      const clause = requireRecord(rawClause, 'evaluation clause');
      return {
        id: requireString(clause.id, 'clause.id'),
        passed: requireBoolean(clause.passed, 'clause.passed'),
      };
    },
  );
  const request = requireRecord(evidence.request, 'evidence.request');
  const backend = requireRecord(evidence.backend, 'evidence.backend');
  const activityPayloads = requireArray(
    request.activityPayloads,
    'evidence.request.activityPayloads',
  );
  const activityReceipts = requireArray(
    backend.activityReceipts,
    'evidence.backend.activityReceipts',
  );
  const identifiableActivityRequests = activityPayloads.filter(
    (rawPayload) =>
      requireString(
        requireRecord(rawPayload, 'activity payload').userId,
        'activity payload.userId',
      ).length > 0,
  ).length;
  const identifiableActivityReceipts = activityReceipts.filter((rawReceipt) => {
    const receipt = requireRecord(rawReceipt, 'activity receipt');
    if (receipt.service !== 'recommendation') {
      return false;
    }
    return requireString(
      requireRecord(receipt.payload, 'activity receipt.payload').userId,
      'activity receipt.payload.userId',
    ).length > 0;
  }).length;
  const recommendation = requireRecord(evidence.recommendation, 'evidence.recommendation');
  const recommendationSource = requireLiteral(
    recommendation.source,
    ['contextual', 'behavioral'] as const,
    'evidence.recommendation.source',
  );
  const itemIds = requireArray(recommendation.itemIds, 'evidence.recommendation.itemIds');
  if (itemIds.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('malformed_artifact', 'Recommendation item IDs must be nonempty strings.');
  }
  const ui = requireRecord(evidence.ui, 'evidence.ui');
  const storage = requireRecord(evidence.storage, 'evidence.storage');
  const journey = requireRecord(evidence.journey, 'evidence.journey');
  const browserErrors = requireArray(observations.browserErrors, 'observations.browserErrors');
  if (browserErrors.some((item) => typeof item !== 'string')) {
    fail('malformed_artifact', 'Browser errors must be strings.');
  }

  return deepFreeze({
    artifact,
    summary: {
      scenario,
      runId,
      userId,
      verdict,
      violationCodes: violations.map((violation) => violation.code),
      passedClauseIds: clauses.filter((clause) => clause.passed).map((clause) => clause.id),
      failedClauseIds: clauses.filter((clause) => !clause.passed).map((clause) => clause.id),
      identifiableActivityRequests,
      identifiableActivityReceipts,
      recommendationSource,
      recommendationItemCount: itemIds.length,
      uiPreference: requireLiteral(ui.preference, ['off', 'on'] as const, 'evidence.ui.preference'),
      storagePreference:
        storage.preference === null
          ? null
          : requireLiteral(
              storage.preference,
              ['off', 'on'] as const,
              'evidence.storage.preference',
            ),
      backendPreference: requireLiteral(
        backend.preference,
        ['off', 'on'] as const,
        'evidence.backend.preference',
      ),
      reloadObserved: requireBoolean(journey.reloadObserved, 'evidence.journey.reloadObserved'),
      browserErrorCount: browserErrors.length,
      artifactSha256,
    },
  });
}

function assertPassingScenario(
  parsed: ReturnType<typeof parseScenarioEvidence>,
  expectedScenario: 'off' | 'on',
): void {
  const { artifact, summary } = parsed;
  const evidence = requireRecord(artifact.evidence, 'evidence');
  const evaluation = requireRecord(artifact.evaluation, 'evaluation');
  const observations = requireRecord(artifact.observations, 'observations');
  const ui = requireRecord(evidence.ui, 'evidence.ui');
  const request = requireRecord(evidence.request, 'evidence.request');
  const backend = requireRecord(evidence.backend, 'evidence.backend');
  const recommendation = requireRecord(evidence.recommendation, 'evidence.recommendation');
  const itemIds = requireArray(recommendation.itemIds, 'evidence.recommendation.itemIds');

  if (
    summary.scenario !== expectedScenario ||
    summary.verdict !== 'pass' ||
    summary.violationCodes.length !== 0 ||
    summary.failedClauseIds.length !== 0 ||
    summary.browserErrorCount !== 0
  ) {
    fail('scenario_semantics_failed', `${expectedScenario.toUpperCase()} evidence was not a clean pass.`);
  }
  const expectedClauses =
    expectedScenario === 'off'
      ? [
          'contextual_feed_functional',
          'no_identifiable_activity',
          'preference_survives_reload',
        ]
      : ['behavioral_feed_functional', 'expected_activity_received'];
  if (
    JSON.stringify([...summary.passedClauseIds].sort()) !==
    JSON.stringify(expectedClauses)
  ) {
    fail('scenario_clause_mismatch', `${expectedScenario.toUpperCase()} clauses differ.`);
  }
  if (requireArray(evaluation.violations, 'evaluation.violations').length !== 0) {
    fail('scenario_semantics_failed', 'Passing evidence contains a violation.');
  }
  if (!requireBoolean(ui.feedFunctional, 'evidence.ui.feedFunctional') || itemIds.length === 0) {
    fail('feed_not_functional', 'Passing evidence has no functional recommendation feed.');
  }

  if (expectedScenario === 'off') {
    if (
      summary.identifiableActivityRequests !== 0 ||
      summary.identifiableActivityReceipts !== 0 ||
      summary.recommendationSource !== 'contextual' ||
      summary.uiPreference !== 'off' ||
      requireBoolean(ui.toggleChecked, 'evidence.ui.toggleChecked') ||
      summary.storagePreference !== 'off' ||
      summary.backendPreference !== 'off' ||
      !summary.reloadObserved ||
      !matchingRecommendationReceipt(evidence, 'contextual', summary.userId, itemIds)
    ) {
      fail('off_contract_semantics_failed', 'OFF evidence does not satisfy every canonical boundary.');
    }
    return;
  }

  const payloads = requireArray(request.activityPayloads, 'evidence.request.activityPayloads');
  const receipts = requireArray(backend.activityReceipts, 'evidence.backend.activityReceipts');
  const networkResponses = requireArray(
    observations.networkActivityResponses,
    'observations.networkActivityResponses',
  );
  const exactCorrelation =
    payloads.length === 1 &&
    receipts.length === 1 &&
    networkResponses.length === 1 &&
    JSON.stringify(requireRecord(receipts[0], 'activity receipt').payload) ===
      JSON.stringify(payloads[0]) &&
    requireRecord(
      networkResponses[0],
      'network activity response',
    ).accepted === true &&
    JSON.stringify(
      requireRecord(
        requireRecord(networkResponses[0], 'network activity response').receipt,
        'network activity response.receipt',
      ).payload,
    ) === JSON.stringify(payloads[0]);
  if (
    summary.identifiableActivityRequests !== 1 ||
    summary.identifiableActivityReceipts !== 1 ||
    !exactCorrelation ||
    summary.recommendationSource !== 'behavioral' ||
    summary.uiPreference !== 'on' ||
    !requireBoolean(ui.toggleChecked, 'evidence.ui.toggleChecked') ||
    summary.storagePreference !== 'on' ||
    summary.backendPreference !== 'on' ||
    !matchingRecommendationReceipt(evidence, 'behavioral', summary.userId, itemIds)
  ) {
    fail('on_control_semantics_failed', 'ON evidence does not prove one correlated activity and a behavioral feed.');
  }
}

async function evidenceFiles(outputDirectory: string): Promise<{
  readonly primary: readonly string[];
  readonly attached: readonly string[];
  readonly all: readonly string[];
}> {
  const all = await listFiles(outputDirectory);
  const matching = all.filter(
    (filePath) =>
      path.basename(filePath).startsWith('promiseproof-evidence-') &&
      filePath.endsWith('.json'),
  );
  return {
    all,
    primary: matching.filter(
      (filePath) => !filePath.split(path.sep).includes('attachments'),
    ),
    attached: matching.filter((filePath) =>
      filePath.split(path.sep).includes('attachments'),
    ),
  };
}

async function requireMatchingEvidenceCopies(input: {
  readonly outputDirectory: string;
  readonly expectedCount: number;
}): Promise<readonly { readonly path: string; readonly body: Buffer }[]> {
  const files = await evidenceFiles(input.outputDirectory);
  if (
    files.primary.length !== input.expectedCount ||
    files.attached.length !== input.expectedCount
  ) {
    fail(
      'unexpected_evidence_count',
      `Expected ${input.expectedCount} primary and attached evidence file(s); observed ${files.primary.length} and ${files.attached.length}.`,
    );
  }
  const remainingAttached = new Map<string, Buffer[]>();
  for (const attachedPath of files.attached) {
    const body = await readFile(attachedPath);
    const digest = sha256Bytes(body);
    const bodies = remainingAttached.get(digest) ?? [];
    bodies.push(body);
    remainingAttached.set(digest, bodies);
  }
  const output: { path: string; body: Buffer }[] = [];
  for (const primaryPath of files.primary) {
    const body = await readFile(primaryPath);
    const digest = sha256Bytes(body);
    const attachedBodies = remainingAttached.get(digest);
    if (attachedBodies === undefined || attachedBodies.length === 0) {
      fail('evidence_copy_mismatch', 'Primary evidence has no byte-identical attachment copy.');
    }
    attachedBodies.pop();
    output.push({ path: primaryPath, body });
  }
  if ([...remainingAttached.values()].some((bodies) => bodies.length > 0)) {
    fail('evidence_copy_mismatch', 'An attached evidence file has no primary copy.');
  }
  return Object.freeze(output.map((entry) => Object.freeze(entry)));
}

export async function validatePassingScenarioArtifacts(input: {
  readonly run: BoundedCommandResult;
  readonly outputDirectory: string;
  readonly projectRoot: string;
  readonly expectedScenario: 'off' | 'on';
  readonly expectedRunCount: number;
  readonly expectedTestFile: string;
}): Promise<PassingScenarioValidation> {
  assertRunnableResult(input.run, 0);
  await assertArtifactFreshness(input.outputDirectory, input.run);
  await readLastRun(input.outputDirectory, 'passed');
  const report = validatePlaywrightJsonReport({
    rawReport: input.run.stdout,
    run: input.run,
    projectRoot: input.projectRoot,
    expectedTestCount: input.expectedRunCount,
    expectedFiles: [input.expectedTestFile],
    expectedOutcome: 'passed',
  });
  const copies = await requireMatchingEvidenceCopies({
    outputDirectory: input.outputDirectory,
    expectedCount: input.expectedRunCount,
  });
  const evidence = copies.map(({ body }) => {
    let raw: unknown;
    try {
      raw = JSON.parse(body.toString('utf8')) as unknown;
    } catch (error) {
      return fail('malformed_artifact', 'Scenario evidence JSON is malformed.', error);
    }
    const parsed = parseScenarioEvidence(raw, sha256Bytes(body));
    assertPassingScenario(parsed, input.expectedScenario);
    return parsed.summary;
  });
  return deepFreeze({ report, evidence });
}

async function requireNonemptyArtifact(
  allFiles: readonly string[],
  predicate: (filePath: string) => boolean,
  label: string,
): Promise<void> {
  const matches = allFiles.filter(predicate);
  if (matches.length !== 1) {
    fail('missing_failure_artifact', `Expected exactly one ${label}; observed ${matches.length}.`);
  }
  const info = await stat(matches[0]!);
  if (!info.isFile() || info.size === 0) {
    fail('empty_failure_artifact', `${label} is empty or not a file.`);
  }
}

export async function validateExpectedRedArtifacts(input: {
  readonly run: BoundedCommandResult;
  readonly outputDirectory: string;
  readonly projectRoot: string;
  readonly expectedCode: 'PP_IDENTIFIABLE_EVENT_LEAK' | 'PP_PREFERENCE_NOT_PERSISTED';
  readonly expectedClause: 'no_identifiable_activity' | 'preference_survives_reload';
  readonly expectedTestFile: string;
}): Promise<ExpectedRedValidation> {
  assertRunnableResult(input.run, 1);
  await assertArtifactFreshness(input.outputDirectory, input.run);
  const terminalCodes = uniquePromiseProofCodes(`${input.run.stdout}\n${input.run.stderr}`);
  if (
    terminalCodes.length !== 1 ||
    terminalCodes[0] !== input.expectedCode
  ) {
    fail(
      'unexpected_terminal_violation_code',
      `Terminal PP_ codes must be exactly ${input.expectedCode}.`,
    );
  }
  await readLastRun(input.outputDirectory, 'failed');
  const report = validatePlaywrightJsonReport({
    rawReport: input.run.stdout,
    run: input.run,
    projectRoot: input.projectRoot,
    expectedTestCount: 1,
    expectedFiles: [input.expectedTestFile],
    expectedOutcome: 'failed',
  });
  const copies = await requireMatchingEvidenceCopies({
    outputDirectory: input.outputDirectory,
    expectedCount: 1,
  });
  const evidenceFile = copies[0]!;
  let raw: unknown;
  try {
    raw = JSON.parse(evidenceFile.body.toString('utf8')) as unknown;
  } catch (error) {
    return fail('malformed_artifact', 'Expected-red evidence JSON is malformed.', error);
  }
  const parsed = parseScenarioEvidence(raw, sha256Bytes(evidenceFile.body));
  if (
    parsed.summary.scenario !== 'off' ||
    parsed.summary.verdict !== 'fail' ||
    parsed.summary.violationCodes.length !== 1 ||
    parsed.summary.violationCodes[0] !== input.expectedCode ||
    parsed.summary.failedClauseIds.length !== 1 ||
    parsed.summary.failedClauseIds[0] !== input.expectedClause ||
    parsed.summary.browserErrorCount !== 0 ||
    parsed.summary.recommendationSource !== 'contextual' ||
    parsed.summary.recommendationItemCount === 0 ||
    !parsed.summary.reloadObserved ||
    parsed.summary.uiPreference !== 'off' ||
    parsed.summary.storagePreference !== 'off'
  ) {
    fail('expected_red_semantics_failed', 'Expected-red evidence is not the exact narrow OFF violation.');
  }
  const artifact = parsed.artifact;
  const evidence = requireRecord(artifact.evidence, 'evidence');
  const ui = requireRecord(evidence.ui, 'evidence.ui');
  const recommendation = requireRecord(
    evidence.recommendation,
    'evidence.recommendation',
  );
  const itemIds = requireArray(
    recommendation.itemIds,
    'evidence.recommendation.itemIds',
  );
  const expectedPassedClauses =
    input.expectedCode === 'PP_IDENTIFIABLE_EVENT_LEAK'
      ? ['contextual_feed_functional', 'preference_survives_reload']
      : ['contextual_feed_functional', 'no_identifiable_activity'];
  if (
    JSON.stringify([...parsed.summary.passedClauseIds].sort()) !==
      JSON.stringify(expectedPassedClauses.sort()) ||
    !requireBoolean(ui.feedFunctional, 'evidence.ui.feedFunctional') ||
    requireBoolean(ui.toggleChecked, 'evidence.ui.toggleChecked') ||
    !matchingRecommendationReceipt(
      evidence,
      'contextual',
      parsed.summary.userId,
      itemIds,
    )
  ) {
    fail(
      'expected_red_semantics_failed',
      'Expected-red evidence did not retain its two healthy OFF clauses.',
    );
  }
  if (
    input.expectedCode === 'PP_IDENTIFIABLE_EVENT_LEAK'
      ? parsed.summary.identifiableActivityRequests !== 1 ||
        parsed.summary.identifiableActivityReceipts !== 1 ||
        parsed.summary.backendPreference !== 'off'
      : parsed.summary.identifiableActivityRequests !== 0 ||
        parsed.summary.identifiableActivityReceipts !== 0 ||
        parsed.summary.backendPreference !== 'on'
  ) {
    fail('expected_red_semantics_failed', 'Expected-red causal evidence does not match its violation.');
  }
  const evidenceCodes = uniquePromiseProofCodes(evidenceFile.body.toString('utf8'));
  if (evidenceCodes.length !== 1 || evidenceCodes[0] !== input.expectedCode) {
    fail('unexpected_evidence_violation_code', 'Evidence contains an unexpected PP_ code.');
  }

  const files = await evidenceFiles(input.outputDirectory);
  await Promise.all([
    requireNonemptyArtifact(
      files.all,
      (filePath) => path.basename(filePath) === 'error-context.md',
      'error context',
    ),
    requireNonemptyArtifact(files.all, (filePath) => filePath.endsWith('.png'), 'failure screenshot'),
    requireNonemptyArtifact(
      files.all,
      (filePath) => path.basename(filePath) === 'video.webm',
      'failure video',
    ),
    requireNonemptyArtifact(
      files.all,
      (filePath) => path.basename(filePath) === 'trace.zip',
      'Playwright trace',
    ),
  ]);
  const errorContext = files.all.find(
    (filePath) => path.basename(filePath) === 'error-context.md',
  )!;
  const contextCodes = uniquePromiseProofCodes(await readFile(errorContext, 'utf8'));
  if (contextCodes.length !== 1 || contextCodes[0] !== input.expectedCode) {
    fail('unexpected_context_violation_code', 'Error context contains an unexpected PP_ code.');
  }

  return deepFreeze({
    report,
    evidence: parsed.summary,
    evidencePath: evidenceFile.path,
    artifactManifest: await buildArtifactManifest(input.outputDirectory),
  });
}

async function writeCommandLogs(
  root: string,
  result: BoundedCommandResult,
): Promise<void> {
  await Promise.all([
    writeFile(path.join(root, `${result.id}.stdout.log`), result.stdout, {
      encoding: 'utf8',
      flag: 'wx',
    }),
    writeFile(path.join(root, `${result.id}.stderr.log`), result.stderr, {
      encoding: 'utf8',
      flag: 'wx',
    }),
  ]);
}

async function ensureNewArtifactRoot(input: {
  readonly artifactRoot: string;
  readonly candidatePath: string;
  readonly verificationPath: string;
}): Promise<string> {
  const requested = path.resolve(input.artifactRoot);
  const parent = await realpath(path.dirname(requested));
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail('unsafe_artifact_root', 'Verification artifact parent must be a real directory.');
  }
  const resolvedTarget = path.join(parent, path.basename(requested));
  if (
    isPathInside(input.candidatePath, resolvedTarget) ||
    isPathInside(input.verificationPath, resolvedTarget) ||
    path.resolve(input.candidatePath) === resolvedTarget ||
    path.resolve(input.verificationPath) === resolvedTarget
  ) {
    fail('unsafe_artifact_root', 'Verification artifacts must remain outside both worktrees.');
  }
  try {
    await mkdir(resolvedTarget, { recursive: false, mode: 0o700 });
  } catch (error) {
    return fail('artifact_root_not_fresh', 'Verification artifact root must not already exist.', error);
  }
  return await realpath(resolvedTarget);
}

async function assertPatchFilesUnchanged(input: {
  readonly handle: DisposableWorktree;
  readonly expectedSourceSha256: string;
  readonly expectedRegressionSha256: string;
  readonly expectedSourceMode: number;
  readonly expectedRegressionMode: number;
}): Promise<void> {
  await verifyDisposableWorktree(input.handle);
  const status = await listGitStatus(input.handle.worktreePath);
  if (status.length !== 2) {
    fail('verification_tree_changed', 'Verification worktree has an unexpected path count.');
  }
  const source = status.find((entry) => entry.path === REPAIR_MODIFIED_SOURCE_PATH);
  const regression = status.find((entry) => entry.path === REPAIR_ADDED_REGRESSION_PATH);
  if (
    source?.kind !== 'tracked' ||
    source.indexStatus !== ' ' ||
    source.worktreeStatus !== 'M' ||
    regression?.kind !== 'untracked' ||
    regression.indexStatus !== '?' ||
    regression.worktreeStatus !== '?'
  ) {
    fail('verification_tree_changed', 'Verification worktree statuses changed.');
  }
  const sourcePath = path.join(
    input.handle.worktreePath,
    ...REPAIR_MODIFIED_SOURCE_PATH.split('/'),
  );
  const regressionPath = path.join(
    input.handle.worktreePath,
    ...REPAIR_ADDED_REGRESSION_PATH.split('/'),
  );
  const [sourceBytes, regressionBytes, sourceInfo, regressionInfo] = await Promise.all([
    readFile(sourcePath),
    readFile(regressionPath),
    lstat(sourcePath),
    lstat(regressionPath),
  ]);
  if (
    !sourceInfo.isFile() ||
    sourceInfo.isSymbolicLink() ||
    !regressionInfo.isFile() ||
    regressionInfo.isSymbolicLink() ||
    sourceInfo.mode !== input.expectedSourceMode ||
    regressionInfo.mode !== input.expectedRegressionMode ||
    sha256Bytes(sourceBytes) !== input.expectedSourceSha256 ||
    sha256Bytes(regressionBytes) !== input.expectedRegressionSha256
  ) {
    fail('verification_patch_changed', 'Approved source or regression bytes changed during verification.');
  }
}

export async function resolveNpmCliPath(): Promise<string> {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
    path.resolve(
      path.dirname(process.execPath),
      '..',
      'lib',
      'node_modules',
      'npm',
      'bin',
      'npm-cli.js',
    ),
  ].flatMap((candidate) =>
    candidate === undefined || !path.isAbsolute(candidate) ? [] : [candidate],
  );
  for (const candidate of [...new Set(candidates)]) {
    try {
      const info = await lstat(candidate);
      if (
        info.isFile() &&
        !info.isSymbolicLink() &&
        path.basename(candidate).toLowerCase() === 'npm-cli.js'
      ) {
        return await realpath(candidate);
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === 'ENOENT'
      ) {
        continue;
      }
      throw error;
    }
  }
  return fail(
    'npm_cli_unavailable',
    'Could not resolve a regular npm-cli.js without invoking a command shell.',
  );
}

function playwrightArgs(
  worktreePath: string,
  config: string,
  outputDirectory: string,
  extra: readonly string[] = [],
): readonly string[] {
  return [
    path.join(worktreePath, 'node_modules', '@playwright', 'test', 'cli.js'),
    'test',
    `--config=${config}`,
    ...extra,
    '--reporter=json',
    '--output',
    outputDirectory,
  ];
}

async function writeFailureReceipt(input: {
  readonly root: string;
  readonly repairId: string;
  readonly baseCommit: string;
  readonly patchSha256: string;
  readonly startedAt: string;
  readonly commands: readonly SafeCommandReceipt[];
  readonly error: unknown;
}): Promise<string> {
  const receiptPath = path.join(input.root, 'verification-failure.json');
  const error = input.error instanceof RepairVerificationError
    ? input.error
    : new RepairVerificationError(
        'unexpected_verification_failure',
        input.error instanceof Error ? input.error.message : String(input.error),
        { cause: input.error },
      );
  let artifactManifest: readonly ArtifactManifestEntry[] = [];
  let artifactManifestError: string | null = null;
  try {
    artifactManifest = await buildArtifactManifest(input.root);
  } catch (manifestError) {
    artifactManifestError =
      manifestError instanceof Error ? manifestError.message : String(manifestError);
  }
  await writeFile(
    receiptPath,
    `${JSON.stringify(
      {
        schemaVersion: REPAIR_VERIFICATION_FAILURE_VERSION,
        repairId: input.repairId,
        verdict: 'fail',
        baseCommit: input.baseCommit,
        approvedPatchSha256: input.patchSha256,
        startedAt: input.startedAt,
        failedAt: new Date().toISOString(),
        error: { code: error.code, message: error.message },
        commands: input.commands,
        retainedArtifacts: artifactManifest,
        artifactManifestError,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return receiptPath;
}

export async function verifyApprovedRepair(
  options: VerifyApprovedRepairOptions,
): Promise<RepairVerificationReceiptV1> {
  const approval = humanRepairDecisionSchema.parse(options.approval);
  if (approval.decision !== 'approved') {
    fail('repair_not_approved', 'Only an explicit approved decision may be verified.');
  }
  if (approval.repairId !== options.expectedRepairId) {
    fail(
      'approval_repair_id_mismatch',
      'Human approval names a different repair ID.',
    );
  }
  if (!GIT_OBJECT_ID.test(options.expectedBaseCommit)) {
    fail(
      'invalid_base_commit',
      'Expected base commit must be a full 40- or 64-hex Git object ID.',
    );
  }
  if (
    !Number.isSafeInteger(options.isolatedPort) ||
    options.isolatedPort < 1024 ||
    options.isolatedPort > 65535
  ) {
    fail('invalid_isolated_port', 'Verification requires an explicit unprivileged TCP port.');
  }
  if (
    options.expectedPatchBytes !== approval.patchBytes ||
    options.expectedPatchBytes <= 0
  ) {
    fail('patch_size_mismatch', 'Approved and expected patch byte counts differ.');
  }

  const candidatePath = await realpath(options.candidateWorktreePath);
  const verificationPath = await realpath(options.verificationWorktree.worktreePath);
  if (
    candidatePath === verificationPath ||
    isPathInside(candidatePath, verificationPath) ||
    isPathInside(verificationPath, candidatePath)
  ) {
    fail('worktrees_not_distinct', 'Candidate and verification worktrees must be distinct.');
  }
  if (options.verificationWorktree.repository.baseHead !== options.expectedBaseCommit) {
    fail('verification_base_mismatch', 'Fresh verification worktree has the wrong base commit.');
  }
  const root = await ensureNewArtifactRoot({
    artifactRoot: options.verificationArtifactRoot,
    candidatePath,
    verificationPath,
  });
  const startedAt = new Date().toISOString();
  const commands: SafeCommandReceipt[] = [];
  const commandRunner = options.commandRunner ?? runBoundedCommand;
  const isolatedEnvironment = await createIsolatedCommandEnvironment(
    options.verificationWorktree.tempRoot,
    options.isolatedPort,
  );
  const environment = isolatedEnvironment.environment;
  const baseUrl = environment.PROMISEPROOF_BASE_URL!;

  const run = async (spec: BoundedCommandSpec): Promise<BoundedCommandResult> => {
    const result = await commandRunner(spec);
    if (result.id !== spec.id) {
      fail('command_identity_mismatch', 'Command runner returned the wrong stage identity.');
    }
    commands.push(safeCommandReceipt(result));
    await writeCommandLogs(root, result);
    return result;
  };

  try {
    await verifyDisposableWorktree(options.verificationWorktree);
    let initialStatus: Awaited<ReturnType<typeof listGitStatus>>;
    try {
      initialStatus = await listGitStatus(verificationPath, {
        includeIgnored: true,
      });
    } catch (error) {
      return fail(
        'verification_worktree_not_fresh',
        'Fresh-worktree inspection could not prove the absence of ignored content.',
        error,
      );
    }
    if (initialStatus.length !== 0) {
      fail(
        'verification_worktree_not_fresh',
        'Fresh verification worktree already contains tracked, untracked, or ignored content.',
      );
    }

    const patchInfo = await lstat(options.retainedPatchPath);
    if (!patchInfo.isFile() || patchInfo.isSymbolicLink()) {
      fail('unsafe_patch_file', 'Retained patch must be a regular non-symlink file.');
    }
    const retainedPatchPath = await realpath(options.retainedPatchPath);
    if (
      retainedPatchPath === candidatePath ||
      retainedPatchPath === verificationPath ||
      isPathInside(candidatePath, retainedPatchPath) ||
      isPathInside(verificationPath, retainedPatchPath)
    ) {
      fail('unsafe_patch_file', 'Retained patch must be copied outside both worktrees.');
    }
    const patchBytes = await readFile(options.retainedPatchPath);
    if (
      patchBytes.byteLength !== options.expectedPatchBytes ||
      sha256Bytes(patchBytes) !== approval.patchSha256
    ) {
      fail('approved_patch_changed', 'Retained patch bytes differ from the human-approved digest.');
    }

    const npmCliPath = await resolveNpmCliPath();
    await runGit(verificationPath, [
      '-c',
      'core.hooksPath=',
      'apply',
      '--check',
      '--whitespace=error-all',
      '--',
      options.retainedPatchPath,
    ]);
    await runGit(verificationPath, [
      '-c',
      'core.hooksPath=',
      'apply',
      '--whitespace=error-all',
      '--',
      options.retainedPatchPath,
    ]);
    const applied = await validateRepairDiff(options.verificationWorktree);
    if (
      applied.patchSha256 !== approval.patchSha256 ||
      applied.patchBytes !== approval.patchBytes ||
      applied.baseHead !== options.expectedBaseCommit
    ) {
      fail('applied_patch_mismatch', 'Fresh-worktree diff differs from the approved patch.');
    }
    const sourcePath = path.join(
      verificationPath,
      ...REPAIR_MODIFIED_SOURCE_PATH.split('/'),
    );
    const regressionPath = path.join(
      verificationPath,
      ...REPAIR_ADDED_REGRESSION_PATH.split('/'),
    );
    const [sourceBytes, regressionBytes, sourceInfo, regressionInfo] = await Promise.all([
      readFile(sourcePath),
      readFile(regressionPath),
      lstat(sourcePath),
      lstat(regressionPath),
    ]);
    const patchFileState = {
      expectedSourceSha256: sha256Bytes(sourceBytes),
      expectedRegressionSha256: sha256Bytes(regressionBytes),
      expectedSourceMode: sourceInfo.mode,
      expectedRegressionMode: regressionInfo.mode,
    };

    const install = await run({
      id: 'install_dependencies',
      executable: process.execPath,
      args: [npmCliPath, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
      cwd: verificationPath,
      environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertRunnableResult(install, 0);
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const build = await run({
      id: 'build',
      executable: process.execPath,
      args: [npmCliPath, 'run', 'build'],
      cwd: verificationPath,
      environment,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    assertRunnableResult(build, 0);
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const playwright = async (
      id: VerificationStageId,
      config: string,
      extra: readonly string[],
    ): Promise<{ readonly run: BoundedCommandResult; readonly outputDirectory: string }> => {
      const outputDirectory = path.join(root, id);
      const result = await run({
        id,
        executable: process.execPath,
        args: playwrightArgs(verificationPath, config, outputDirectory, extra),
        cwd: verificationPath,
        environment,
        timeoutMs: PLAYWRIGHT_TIMEOUT_MS,
        outputDirectory,
      });
      return { run: result, outputDirectory };
    };

    const raceOffSingleRun = await playwright(
      'race_off_single',
      'tests/contracts/playwright.config.ts',
      [],
    );
    const raceOffSingle = await validatePassingScenarioArtifacts({
      ...raceOffSingleRun,
      projectRoot: verificationPath,
      expectedScenario: 'off',
      expectedRunCount: 1,
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const raceOnSingleRun = await playwright(
      'race_on_single',
      'playwright.config.ts',
      ['tests/control/personalization-on.spec.ts'],
    );
    const raceOnSingle = await validatePassingScenarioArtifacts({
      ...raceOnSingleRun,
      projectRoot: verificationPath,
      expectedScenario: 'on',
      expectedRunCount: 1,
      expectedTestFile: 'tests/control/personalization-on.spec.ts',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const raceOffFiveRun = await playwright(
      'race_off_repeat_5',
      'tests/contracts/playwright.config.ts',
      ['--repeat-each=5'],
    );
    const raceOffFive = await validatePassingScenarioArtifacts({
      ...raceOffFiveRun,
      projectRoot: verificationPath,
      expectedScenario: 'off',
      expectedRunCount: 5,
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const raceOnFiveRun = await playwright(
      'race_on_repeat_5',
      'playwright.config.ts',
      ['tests/control/personalization-on.spec.ts', '--repeat-each=5'],
    );
    const raceOnFive = await validatePassingScenarioArtifacts({
      ...raceOnFiveRun,
      projectRoot: verificationPath,
      expectedScenario: 'on',
      expectedRunCount: 5,
      expectedTestFile: 'tests/control/personalization-on.spec.ts',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const propagationRedRun = await playwright(
      'propagation_expected_red',
      'tests/propagation/contract.config.ts',
      [],
    );
    const propagationRed = await validateExpectedRedArtifacts({
      ...propagationRedRun,
      projectRoot: verificationPath,
      expectedCode: 'PP_PREFERENCE_NOT_PERSISTED',
      expectedClause: 'preference_survives_reload',
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const propagationGreenRun = await playwright(
      'propagation_green',
      'tests/propagation/playwright.config.ts',
      [],
    );
    assertRunnableResult(propagationGreenRun.run, 0);
    await readLastRun(propagationGreenRun.outputDirectory, 'passed');
    const propagationGreen = validatePlaywrightJsonReport({
      rawReport: propagationGreenRun.run.stdout,
      run: propagationGreenRun.run,
      projectRoot: verificationPath,
      expectedTestCount: 6,
      expectedFiles: [
        'tests/control/personalization-on.spec.ts',
        'tests/investigation/offline.spec.ts',
        'tests/propagation/detector.spec.ts',
        'tests/propagation/health.spec.ts',
        'tests/propagation/manual-observation.spec.ts',
        'tests/propagation/replays.spec.ts',
      ],
      expectedOutcome: 'passed',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    // The model-authored regression executes last so it cannot modify ignored test
    // binaries before an authoritative canonical or propagation check.
    const regressionRun = await playwright(
      'startup_regression',
      'playwright.config.ts',
      [REPAIR_ADDED_REGRESSION_PATH],
    );
    assertRunnableResult(regressionRun.run, 0);
    await readLastRun(regressionRun.outputDirectory, 'passed');
    const regression = validatePlaywrightJsonReport({
      rawReport: regressionRun.run.stdout,
      run: regressionRun.run,
      projectRoot: verificationPath,
      expectedTestCount: 1,
      expectedFiles: [REPAIR_ADDED_REGRESSION_PATH],
      expectedOutcome: 'passed',
    });
    await assertPatchFilesUnchanged({ handle: options.verificationWorktree, ...patchFileState });

    const finalPatchBytes = await readFile(options.retainedPatchPath);
    if (
      finalPatchBytes.byteLength !== options.expectedPatchBytes ||
      sha256Bytes(finalPatchBytes) !== approval.patchSha256
    ) {
      fail('approved_patch_changed', 'Retained patch changed during verification.');
    }

    const completedAt = new Date().toISOString();
    const retainedArtifacts = await buildArtifactManifest(root);
    const receipt: RepairVerificationReceiptV1 = deepFreeze({
      schemaVersion: REPAIR_VERIFICATION_RECEIPT_VERSION,
      repairId: approval.repairId,
      verdict: 'pass',
      baseCommit: options.expectedBaseCommit,
      approvedPatchSha256: approval.patchSha256,
      patchBytes: approval.patchBytes,
      verificationWorktreeFresh: true,
      candidateAndVerificationWorktreesDistinct: true,
      patchAppliedByExactDigest: true,
      patchUnchangedAfterVerification: true,
      isolatedPort: options.isolatedPort,
      baseUrl,
      startedAt,
      completedAt,
      commands,
      checks: {
        build: true,
        raceOffSingle: raceOffSingle.evidence[0]!,
        raceOnSingle: raceOnSingle.evidence[0]!,
        raceOffFive: raceOffFive.evidence,
        raceOnFive: raceOnFive.evidence,
        propagationExpectedRed: propagationRed.evidence,
        propagationGreenTestCount: propagationGreen.discoveredTests as 6,
        startupRegressionTestCount: regression.discoveredTests as 1,
      },
      retainedArtifacts,
    });
    await writeFile(
      path.join(root, 'verification-receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return receipt;
  } catch (error) {
    const receiptPath = await writeFailureReceipt({
      root,
      repairId: approval.repairId,
      baseCommit: options.expectedBaseCommit,
      patchSha256: approval.patchSha256,
      startedAt,
      commands,
      error,
    });
    if (error instanceof RepairVerificationError) {
      throw new RepairVerificationError(error.code, error.message, {
        cause: error,
        failureReceiptPath: receiptPath,
      });
    }
    throw new RepairVerificationError(
      'unexpected_verification_failure',
      error instanceof Error ? error.message : String(error),
      { cause: error, failureReceiptPath: receiptPath },
    );
  } finally {
    await isolatedEnvironment.cleanup();
  }
}
