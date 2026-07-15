import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { evaluatePromise } from '../../src/shared/evaluator.js';
import type { PromiseEvidence } from '../../src/shared/types.js';
import {
  expectedReviewPhrase,
  type HumanRepairDecisionV1,
} from '../../src/repair/approval.js';
import { validateRepairDiff } from '../../src/repair/diff-validator.js';
import { runGit } from '../../src/repair/git.js';
import {
  cleanupDisposableWorktree,
  createDisposableWorktree,
  type DisposableWorktree,
} from '../../src/repair/worktree.js';
import {
  RepairVerificationError,
  runBoundedCommand,
  safeCommandReceipt,
  validateExpectedRedArtifacts,
  validatePassingScenarioArtifacts,
  validatePlaywrightJsonReport,
  verifyApprovedRepair,
  type BoundedCommandResult,
  type BoundedCommandRunner,
  type BoundedCommandSpec,
} from '../../src/repair/verification.js';

const temporaryDirectories: string[] = [];
const worktrees: DisposableWorktree[] = [];

afterEach(async () => {
  for (const worktree of worktrees.splice(0).reverse()) {
    try {
      await cleanupDisposableWorktree(worktree);
    } catch {
      // The assertion that failed is more useful than a duplicate cleanup error.
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function item(id: string) {
  return {
    id,
    title: `Title ${id}`,
    description: `Description ${id}`,
    eyebrow: `Eyebrow ${id}`,
  };
}

function offEvidence(options: {
  readonly runId?: string;
  readonly leak?: boolean;
  readonly backendPreference?: 'off' | 'on';
} = {}): PromiseEvidence {
  const runId = options.runId ?? 'repair-off-001';
  const userId = 'repair-user-off';
  const payload = {
    runId,
    userId,
    eventType: 'page_view' as const,
    itemId: 'home',
    clientSequence: 1,
    occurredAt: '2026-07-15T10:00:00.000Z',
  };
  const activityReceipt = {
    kind: 'activity' as const,
    service: 'recommendation' as const,
    receiptId: `${runId}:activity`,
    sequence: 1,
    receivedAt: '2026-07-15T10:00:00.010Z',
    payload,
  };
  return {
    scenario: 'off',
    runId,
    userId,
    ui: { preference: 'off', toggleChecked: false, feedFunctional: true },
    storage: { preference: 'off' },
    request: {
      activityPayloads: options.leak === true ? [payload] : [],
      preferenceUpdates: [],
    },
    response: { preferenceUpdates: [] },
    backend: {
      preference: options.backendPreference ?? 'off',
      activityReceipts: options.leak === true ? [activityReceipt] : [],
      recommendationReceipts: [
        {
          kind: 'recommendation',
          receiptId: `${runId}:recommendation`,
          sequence: 2,
          receivedAt: '2026-07-15T10:00:00.020Z',
          source: 'contextual',
          items: [item('context-1')],
        },
      ],
      preferenceReceipts: [],
    },
    recommendation: { source: 'contextual', itemIds: ['context-1'] },
    timestamps: {
      clientTimeline: [],
      activityReceivedAt: options.leak === true
        ? ['2026-07-15T10:00:00.010Z']
        : [],
      preferenceReceivedAt: [],
      recommendationReceivedAt: ['2026-07-15T10:00:00.020Z'],
    },
    journey: { reloadObserved: true },
  };
}

function onEvidence(runId = 'repair-on-001'): PromiseEvidence {
  const userId = 'repair-user-on';
  const payload = {
    runId,
    userId,
    eventType: 'page_view' as const,
    itemId: 'home',
    clientSequence: 1,
    occurredAt: '2026-07-15T10:01:00.000Z',
  };
  const activityReceipt = {
    kind: 'activity' as const,
    service: 'recommendation' as const,
    receiptId: `${runId}:activity`,
    sequence: 1,
    receivedAt: '2026-07-15T10:01:00.010Z',
    payload,
  };
  return {
    scenario: 'on',
    runId,
    userId,
    ui: { preference: 'on', toggleChecked: true, feedFunctional: true },
    storage: { preference: 'on' },
    request: { activityPayloads: [payload], preferenceUpdates: [] },
    response: { preferenceUpdates: [] },
    backend: {
      preference: 'on',
      activityReceipts: [activityReceipt],
      recommendationReceipts: [
        {
          kind: 'recommendation',
          receiptId: `${runId}:recommendation`,
          sequence: 2,
          receivedAt: '2026-07-15T10:01:00.020Z',
          source: 'behavioral',
          userId,
          items: [item('behavior-1')],
        },
      ],
      preferenceReceipts: [],
    },
    recommendation: { source: 'behavioral', itemIds: ['behavior-1'] },
    timestamps: {
      clientTimeline: [],
      activityReceivedAt: ['2026-07-15T10:01:00.010Z'],
      preferenceReceivedAt: [],
      recommendationReceivedAt: ['2026-07-15T10:01:00.020Z'],
    },
    journey: { reloadObserved: false },
  };
}

function artifact(evidence: PromiseEvidence): Record<string, unknown> {
  const activityReceipt = evidence.backend.activityReceipts[0];
  return {
    schemaVersion: 2,
    evidence,
    evaluation: evaluatePromise(evidence),
    observations: {
      browserErrors: [],
      networkActivityResponses:
        activityReceipt === undefined
          ? []
          : [{ accepted: true, receipt: activityReceipt }],
    },
  };
}

interface ReportInput {
  readonly startedAt: string;
  readonly rootDir: string;
  readonly files: readonly string[];
  readonly testCount: number;
  readonly outcome: 'passed' | 'failed';
  readonly code?: string;
}

function jsonReport(input: ReportInput): string {
  const testsPerFile = input.files.map((file, fileIndex) => {
    const count =
      fileIndex === 0
        ? input.testCount - (input.files.length - 1)
        : 1;
    return {
      file,
      tests: Array.from({ length: count }, () => ({
        expectedStatus: 'passed',
        status: input.outcome === 'passed' ? 'expected' : 'unexpected',
        results: [
          {
            status: input.outcome,
            ...(input.code === undefined
              ? {}
              : { errors: [{ message: input.code }] }),
          },
        ],
      })),
    };
  });
  return JSON.stringify({
    config: { rootDir: input.rootDir },
    suites: [{ specs: testsPerFile }],
    errors: [],
    stats: {
      startTime: input.startedAt,
      duration: 1,
      expected: input.outcome === 'passed' ? input.testCount : 0,
      skipped: 0,
      unexpected: input.outcome === 'failed' ? input.testCount : 0,
      flaky: 0,
    },
  });
}

function commandResult(input: {
  readonly id: string;
  readonly exitCode: number;
  readonly files?: readonly string[];
  readonly testCount?: number;
  readonly outcome?: 'passed' | 'failed';
  readonly code?: string;
  readonly stdout?: string;
  readonly rootDir?: string;
}): BoundedCommandResult {
  const start = Date.now();
  const startedAt = new Date(start).toISOString();
  const stdout = input.stdout ??
    (input.files === undefined
      ? ''
      : jsonReport({
          startedAt,
          rootDir: input.rootDir ?? path.join(path.resolve('.'), 'tests'),
          files: input.files,
          testCount: input.testCount ?? 1,
          outcome: input.outcome ?? 'passed',
          ...(input.code === undefined ? {} : { code: input.code }),
        }));
  return {
    id: input.id,
    exitCode: input.exitCode,
    signal: null,
    stdout,
    stderr: '',
    startedAt,
    completedAt: new Date(start + 1).toISOString(),
    durationMs: 1,
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
  };
}

async function freshRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

async function writeLastRun(
  outputDirectory: string,
  outcome: 'passed' | 'failed',
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    path.join(outputDirectory, '.last-run.json'),
    JSON.stringify({
      status: outcome,
      failedTests: outcome === 'failed' ? ['one'] : [],
    }),
  );
}

async function writeEvidenceCopies(
  outputDirectory: string,
  values: readonly Record<string, unknown>[],
): Promise<void> {
  for (let index = 0; index < values.length; index += 1) {
    const resultDirectory = path.join(outputDirectory, `case-${index + 1}`);
    const attachmentsDirectory = path.join(resultDirectory, 'attachments');
    await mkdir(attachmentsDirectory, { recursive: true });
    const body = JSON.stringify(values[index]);
    await Promise.all([
      writeFile(
        path.join(resultDirectory, `promiseproof-evidence-${index + 1}.json`),
        body,
      ),
      writeFile(
        path.join(
          attachmentsDirectory,
          `promiseproof-evidence-${index + 1}-json-hash.json`,
        ),
        body,
      ),
    ]);
  }
}

async function writePassingOutput(
  outputDirectory: string,
  values: readonly Record<string, unknown>[],
): Promise<void> {
  await writeLastRun(outputDirectory, 'passed');
  await writeEvidenceCopies(outputDirectory, values);
}

async function writeExpectedRedOutput(
  outputDirectory: string,
  value: Record<string, unknown>,
  code: string,
): Promise<void> {
  await writeLastRun(outputDirectory, 'failed');
  await writeEvidenceCopies(outputDirectory, [value]);
  const resultDirectory = path.join(outputDirectory, 'case-1');
  await Promise.all([
    writeFile(path.join(resultDirectory, 'error-context.md'), code),
    writeFile(path.join(resultDirectory, 'test-failed-1.png'), 'png'),
    writeFile(path.join(resultDirectory, 'video.webm'), 'video'),
    writeFile(path.join(resultDirectory, 'trace.zip'), 'trace'),
  ]);
}

test('bounded runner and safe receipt retain hashes without a shell', async () => {
  const result = await runBoundedCommand({
    id: 'unit_command',
    executable: process.execPath,
    args: ['-e', "process.stdout.write('bounded-ok')"],
    cwd: path.resolve('.'),
    environment: { ...process.env },
    timeoutMs: 5_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'bounded-ok');
  assert.equal(result.timedOut, false);
  const receipt = safeCommandReceipt(result);
  assert.equal(receipt.stdoutBytes, 10);
  assert.match(receipt.stdoutSha256, /^[a-f0-9]{64}$/u);
  assert.equal('stdout' in receipt, false);
});

test('passing OFF validator requires exact report, copies, and canonical semantics', async () => {
  const root = await freshRoot('promiseproof-verifier-off-');
  const output = path.join(root, 'output');
  const evidence = artifact(offEvidence());
  await writePassingOutput(output, [evidence]);
  const run = commandResult({
    id: 'race_off_single',
    exitCode: 0,
    files: ['contracts/personalization-off.spec.ts'],
  });
  const result = await validatePassingScenarioArtifacts({
    run,
    outputDirectory: output,
    projectRoot: path.resolve('.'),
    expectedScenario: 'off',
    expectedRunCount: 1,
    expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
  });
  assert.equal(result.evidence[0]?.verdict, 'pass');
  assert.equal(result.evidence[0]?.identifiableActivityRequests, 0);
  assert.equal(result.evidence[0]?.recommendationSource, 'contextual');

  const stale: BoundedCommandResult = {
    ...run,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  };
  await assert.rejects(
    validatePassingScenarioArtifacts({
      run: stale,
      outputDirectory: output,
      projectRoot: path.resolve('.'),
      expectedScenario: 'off',
      expectedRunCount: 1,
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'stale_playwright_artifact',
  );
});

test('passing ON validator rejects extra activity despite a modelled pass verdict', async () => {
  const root = await freshRoot('promiseproof-verifier-on-');
  const output = path.join(root, 'output');
  const evidence = onEvidence();
  const extra = structuredClone(evidence.request.activityPayloads[0]!);
  extra.clientSequence = 2;
  evidence.request.activityPayloads.push(extra);
  const value = artifact(evidence);
  assert.equal((value.evaluation as { verdict: string }).verdict, 'pass');
  await writePassingOutput(output, [value]);
  const run = commandResult({
    id: 'race_on_single',
    exitCode: 0,
    files: ['control/personalization-on.spec.ts'],
  });
  await assert.rejects(
    validatePassingScenarioArtifacts({
      run,
      outputDirectory: output,
      projectRoot: path.resolve('.'),
      expectedScenario: 'on',
      expectedRunCount: 1,
      expectedTestFile: 'tests/control/personalization-on.spec.ts',
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'on_control_semantics_failed',
  );
});

test('expected-red validator requires the single propagation code and full artifacts', async () => {
  const root = await freshRoot('promiseproof-verifier-red-');
  const output = path.join(root, 'output');
  const code = 'PP_PREFERENCE_NOT_PERSISTED';
  await writeExpectedRedOutput(
    output,
    artifact(offEvidence({ backendPreference: 'on' })),
    code,
  );
  const run = commandResult({
    id: 'propagation_expected_red',
    exitCode: 1,
    files: ['contracts/personalization-off.spec.ts'],
    outcome: 'failed',
    code,
  });
  const result = await validateExpectedRedArtifacts({
    run,
    outputDirectory: output,
    projectRoot: path.resolve('.'),
    expectedCode: code,
    expectedClause: 'preference_survives_reload',
    expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
  });
  assert.deepEqual(result.evidence.violationCodes, [code]);
  assert.equal(result.evidence.backendPreference, 'on');
  assert.equal(result.artifactManifest.some((entry) => entry.path.endsWith('trace.zip')), true);

  await assert.rejects(
    validateExpectedRedArtifacts({
      run: { ...run, stderr: 'PP_UNRELATED_FAILURE' },
      outputDirectory: output,
      projectRoot: path.resolve('.'),
      expectedCode: code,
      expectedClause: 'preference_survives_reload',
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'unexpected_terminal_violation_code',
  );

  await rm(path.join(output, 'case-1', 'trace.zip'));
  await assert.rejects(
    validateExpectedRedArtifacts({
      run,
      outputDirectory: output,
      projectRoot: path.resolve('.'),
      expectedCode: code,
      expectedClause: 'preference_survives_reload',
      expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'missing_failure_artifact',
  );
});

test('expected-red validator distinguishes the startup leak semantics', async () => {
  const root = await freshRoot('promiseproof-verifier-race-red-');
  const output = path.join(root, 'output');
  const code = 'PP_IDENTIFIABLE_EVENT_LEAK';
  await writeExpectedRedOutput(output, artifact(offEvidence({ leak: true })), code);
  const run = commandResult({
    id: 'race_expected_red',
    exitCode: 1,
    files: ['contracts/personalization-off.spec.ts'],
    outcome: 'failed',
    code,
  });
  const result = await validateExpectedRedArtifacts({
    run,
    outputDirectory: output,
    projectRoot: path.resolve('.'),
    expectedCode: code,
    expectedClause: 'no_identifiable_activity',
    expectedTestFile: 'tests/contracts/personalization-off.spec.ts',
  });
  assert.equal(result.evidence.identifiableActivityRequests, 1);
  assert.equal(result.evidence.identifiableActivityReceipts, 1);
  assert.equal(result.evidence.backendPreference, 'off');
});

test('JSON report validator rejects zero tests and changed test files', () => {
  const run = commandResult({
    id: 'report',
    exitCode: 0,
    files: ['control/personalization-on.spec.ts'],
  });
  assert.throws(
    () =>
      validatePlaywrightJsonReport({
        rawReport: run.stdout,
        run,
        projectRoot: path.resolve('.'),
        expectedTestCount: 0,
        expectedFiles: ['tests/control/personalization-on.spec.ts'],
        expectedOutcome: 'passed',
      }),
    (error: unknown) =>
      error instanceof RepairVerificationError && error.code === 'unexpected_test_count',
  );
  assert.throws(
    () =>
      validatePlaywrightJsonReport({
        rawReport: run.stdout,
        run,
        projectRoot: path.resolve('.'),
        expectedTestCount: 1,
        expectedFiles: ['tests/contracts/personalization-off.spec.ts'],
        expectedOutcome: 'passed',
      }),
    (error: unknown) =>
      error instanceof RepairVerificationError && error.code === 'unexpected_test_file',
  );
});

async function initializeFixtureRepository(root: string): Promise<string> {
  const repository = path.join(root, 'repository');
  await mkdir(path.join(repository, 'src', 'client'), { recursive: true });
  await Promise.all([
    writeFile(path.join(repository, '.gitignore'), 'node_modules/\ndist/\ntest-results/\n'),
    writeFile(
      path.join(repository, 'src', 'client', 'main.ts'),
      `export async function boot(demoMode: string): Promise<void> {
    if (demoMode === "initialization-race") {
      setStatus("Collector starting first", "working");
      await runStartupCollector();
      await hydratePreference();
    } else {
      await hydratePreference();
      await runStartupCollector();
    }
}

declare function setStatus(message: string, state: string): void;
declare function runStartupCollector(): Promise<void>;
declare function hydratePreference(): Promise<void>;
`,
    ),
    writeFile(path.join(repository, 'package.json'), '{"private":true}\n'),
    writeFile(
      path.join(repository, 'package-lock.json'),
      '{"name":"fixture","lockfileVersion":3,"requires":true,"packages":{"":{"name":"fixture"}}}\n',
    ),
  ]);
  await runGit(repository, ['init']);
  await runGit(repository, ['config', 'user.name', 'AlexPaiva']);
  await runGit(repository, ['config', 'user.email', 'alexandrep@ua.pt']);
  await runGit(repository, ['add', '--', '.gitignore', 'package.json', 'package-lock.json', 'src/client/main.ts']);
  await runGit(repository, ['commit', '-m', 'fixture base']);
  return repository;
}

function fakeVerificationRunner(): {
  readonly runner: BoundedCommandRunner;
  readonly stageIds: string[];
} {
  const stageIds: string[] = [];
  const runner = async (spec: BoundedCommandSpec): Promise<BoundedCommandResult> => {
    stageIds.push(spec.id);
    assert.equal(spec.environment.PORT, '45123');
    assert.equal(
      spec.environment.PROMISEPROOF_BASE_URL,
      'http://127.0.0.1:45123',
    );
    assert.equal(spec.environment.OPENAI_API_KEY, undefined);
    assert.equal(spec.environment.HTTP_PROXY, undefined);
    assert.equal(spec.environment.HTTPS_PROXY, undefined);
    assert.equal(
      await readFile(spec.environment.NPM_CONFIG_USERCONFIG!, 'utf8'),
      '',
    );
    assert.equal(
      await readFile(spec.environment.NPM_CONFIG_GLOBALCONFIG!, 'utf8'),
      '',
    );
    assert.equal(
      spec.environment.NPM_CONFIG_CACHE?.startsWith(
        path.join(path.dirname(spec.cwd), 'command-runtime'),
      ),
      true,
    );
    if (spec.id === 'install_dependencies') {
      assert.equal(spec.executable, process.execPath);
      assert.equal(spec.args.includes('ci'), true);
      assert.equal(spec.args.includes('--ignore-scripts'), true);
      return commandResult({ id: spec.id, exitCode: 0, stdout: 'installed' });
    }
    if (spec.id === 'build') {
      return commandResult({ id: spec.id, exitCode: 0, stdout: 'built' });
    }
    assert.notEqual(spec.outputDirectory, undefined);
    const output = spec.outputDirectory!;
    if (spec.id === 'race_off_single' || spec.id === 'race_off_repeat_5') {
      const count = spec.id === 'race_off_single' ? 1 : 5;
      await writePassingOutput(
        output,
        Array.from({ length: count }, (_, index) =>
          artifact(offEvidence({ runId: `off-${index + 1}` })),
        ),
      );
      return commandResult({
        id: spec.id,
        exitCode: 0,
        files: ['personalization-off.spec.ts'],
        rootDir: path.join(spec.cwd, 'tests', 'contracts'),
        testCount: count,
      });
    }
    if (spec.id === 'race_on_single' || spec.id === 'race_on_repeat_5') {
      const count = spec.id === 'race_on_single' ? 1 : 5;
      await writePassingOutput(
        output,
        Array.from({ length: count }, (_, index) =>
          artifact(onEvidence(`on-${index + 1}`)),
        ),
      );
      return commandResult({
        id: spec.id,
        exitCode: 0,
        files: ['control/personalization-on.spec.ts'],
        rootDir: path.join(spec.cwd, 'tests'),
        testCount: count,
      });
    }
    if (spec.id === 'propagation_expected_red') {
      const code = 'PP_PREFERENCE_NOT_PERSISTED';
      await writeExpectedRedOutput(
        output,
        artifact(offEvidence({ backendPreference: 'on' })),
        code,
      );
      return commandResult({
        id: spec.id,
        exitCode: 1,
        files: ['contracts/personalization-off.spec.ts'],
        rootDir: path.join(spec.cwd, 'tests'),
        outcome: 'failed',
        code,
      });
    }
    if (spec.id === 'propagation_green') {
      const files = [
        'control/personalization-on.spec.ts',
        'investigation/offline.spec.ts',
        'propagation/detector.spec.ts',
        'propagation/health.spec.ts',
        'propagation/manual-observation.spec.ts',
        'propagation/replays.spec.ts',
      ];
      await writeLastRun(output, 'passed');
      return commandResult({
        id: spec.id,
        exitCode: 0,
        files,
        testCount: 6,
        rootDir: path.join(spec.cwd, 'tests'),
      });
    }
    if (spec.id === 'startup_regression') {
      await writeLastRun(output, 'passed');
      return commandResult({
        id: spec.id,
        exitCode: 0,
        files: ['regression/initialization-order.spec.ts'],
        rootDir: path.join(spec.cwd, 'tests'),
      });
    }
    throw new Error(`Unexpected fake stage: ${spec.id}`);
  };
  return { runner, stageIds };
}

test('approved repair is applied and verified only in a second real worktree', async () => {
  const root = await freshRoot('promiseproof-verifier-e2e-');
  const repository = await initializeFixtureRepository(root);
  const candidate = await createDisposableWorktree(repository);
  worktrees.push(candidate);
  await mkdir(path.join(candidate.worktreePath, 'tests', 'regression'), {
    recursive: true,
  });
  await Promise.all([
    writeFile(
      path.join(candidate.worktreePath, 'src', 'client', 'main.ts'),
      `export async function boot(demoMode: string): Promise<void> {
    if (demoMode === "initialization-race") {
      setStatus("Restoring preference before activity collection", "working");
      await hydratePreference();
      await runStartupCollector();
    } else {
      await hydratePreference();
      await runStartupCollector();
    }
}

declare function setStatus(message: string, state: string): void;
declare function runStartupCollector(): Promise<void>;
declare function hydratePreference(): Promise<void>;
`,
    ),
    writeFile(
      path.join(
        candidate.worktreePath,
        'tests',
        'regression',
        'initialization-order.spec.ts',
      ),
      [
        "import { expect, test } from '@playwright/test';",
        "import { runPromiseScenario } from '../support/scenario.js';",
        '',
        "test('hydrates OFF before the activity collector starts', async ({ page, request }, testInfo) => {",
        "  const result = await runPromiseScenario(page, request, testInfo, 'off', {",
        "    runId: 'regression-off-001',",
        "    userId: 'regression-user-off',",
        '  });',
        '  expect(result.browserErrors).toEqual([]);',
        '  expect(result.evidence.request.activityPayloads).toEqual([]);',
        '  expect(result.evidence.backend.activityReceipts).toEqual([]);',
        '  expect(result.evaluation.violations).toEqual([]);',
        '  expect(result.evidence.journey.reloadObserved).toBe(true);',
        "  expect(result.evidence.recommendation.source).toBe('contextual');",
        '  const events = result.evidence.timestamps.clientTimeline.map(',
        '    (entry) => entry.event,',
        '  );',
        "  const hydrationCompleted = events.indexOf('preference_hydration_completed');",
        "  const collectorStarted = events.indexOf('collector_started');",
        '  expect(hydrationCompleted).toBeGreaterThanOrEqual(0);',
        '  expect(collectorStarted).toBeGreaterThanOrEqual(0);',
        '  expect(hydrationCompleted).toBeLessThan(collectorStarted);',
        '});',
        '',
      ].join('\n'),
    ),
  ]);
  const validated = await validateRepairDiff(candidate);
  const retainedPatchPath = path.join(root, 'approved.patch');
  await writeFile(retainedPatchPath, validated.patch, 'utf8');

  const verification = await createDisposableWorktree(repository);
  worktrees.push(verification);
  assert.notEqual(candidate.worktreePath, verification.worktreePath);
  const repairId = randomUUID();
  const approval: HumanRepairDecisionV1 = {
    schemaVersion: 'promiseproof.human-repair-decision.v1',
    repairId,
    decision: 'approved',
    patchSha256: validated.patchSha256,
    patchBytes: validated.patchBytes,
    decidedAt: new Date().toISOString(),
    reviewer: 'human_operator',
    method: 'interactive_tty_exact_phrase',
    confirmationSha256: createHash('sha256')
      .update(
        expectedReviewPhrase('APPROVE', repairId, validated.patchSha256),
        'utf8',
      )
      .digest('hex'),
  };
  await assert.rejects(
    verifyApprovedRepair({
      expectedRepairId: randomUUID(),
      verificationWorktree: verification,
      candidateWorktreePath: candidate.worktreePath,
      retainedPatchPath,
      expectedPatchBytes: validated.patchBytes,
      expectedBaseCommit: validated.baseHead,
      approval,
      verificationArtifactRoot: path.join(root, 'wrong-repair-id'),
      isolatedPort: 45123,
      commandRunner: async () => {
        throw new Error('wrong repair ID must fail before commands');
      },
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'approval_repair_id_mismatch',
  );
  const taintedVerification = await createDisposableWorktree(repository);
  worktrees.push(taintedVerification);
  await mkdir(path.join(taintedVerification.worktreePath, 'node_modules'), {
    recursive: true,
  });
  await writeFile(
    path.join(taintedVerification.worktreePath, 'node_modules', 'poison.js'),
    'ignored but not fresh\n',
  );
  await assert.rejects(
    verifyApprovedRepair({
      expectedRepairId: repairId,
      verificationWorktree: taintedVerification,
      candidateWorktreePath: candidate.worktreePath,
      retainedPatchPath,
      expectedPatchBytes: validated.patchBytes,
      expectedBaseCommit: validated.baseHead,
      approval,
      verificationArtifactRoot: path.join(root, 'tainted-verification'),
      isolatedPort: 45123,
      commandRunner: async () => {
        throw new Error('tainted worktree must fail before commands');
      },
    }),
    (error: unknown) =>
      error instanceof RepairVerificationError &&
      error.code === 'verification_worktree_not_fresh' &&
      error.failureReceiptPath !== null,
  );
  const fake = fakeVerificationRunner();
  const receipt = await verifyApprovedRepair({
    expectedRepairId: repairId,
    verificationWorktree: verification,
    candidateWorktreePath: candidate.worktreePath,
    retainedPatchPath,
    expectedPatchBytes: validated.patchBytes,
    expectedBaseCommit: validated.baseHead,
    approval,
    verificationArtifactRoot: path.join(root, 'retained-verification'),
    isolatedPort: 45123,
    commandRunner: fake.runner,
  });
  assert.equal(receipt.verdict, 'pass');
  assert.equal(receipt.approvedPatchSha256, validated.patchSha256);
  assert.equal(receipt.checks.raceOffFive.length, 5);
  assert.equal(receipt.checks.raceOnFive.length, 5);
  assert.equal(receipt.checks.propagationExpectedRed.violationCodes[0], 'PP_PREFERENCE_NOT_PERSISTED');
  assert.deepEqual(fake.stageIds, [
    'install_dependencies',
    'build',
    'race_off_single',
    'race_on_single',
    'race_off_repeat_5',
    'race_on_repeat_5',
    'propagation_expected_red',
    'propagation_green',
    'startup_regression',
  ]);
  const receiptOnDisk = JSON.parse(
    await readFile(
      path.join(root, 'retained-verification', 'verification-receipt.json'),
      'utf8',
    ),
  ) as { verdict: string };
  assert.equal(receiptOnDisk.verdict, 'pass');
  await assert.rejects(
    access(path.join(verification.tempRoot, 'command-runtime')),
    { code: 'ENOENT' },
  );
});
