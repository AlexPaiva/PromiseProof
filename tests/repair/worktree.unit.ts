import assert from 'node:assert/strict';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  MAX_REPAIR_CHANGED_LINES,
  MAX_REPAIR_PATCH_BYTES,
  RepairDiffValidationError,
  validateRepairDiff,
} from '../../src/repair/diff-validator.js';
import {
  captureRefState,
  equalRefStates,
  resolveRepositoryPath,
  runGit,
} from '../../src/repair/git.js';
import {
  WorktreeBoundaryError,
  cleanupDisposableWorktree,
  createDisposableWorktree,
  inspectDisposableWorktree,
  reopenDisposableWorktree,
  verifyDisposableWorktree,
  type DisposableWorktree,
} from '../../src/repair/worktree.js';

const BASE_SOURCE = `export async function boot(demoMode: string): Promise<void> {
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
`;

const REPAIRED_SOURCE = `export async function boot(demoMode: string): Promise<void> {
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
`;

const REGRESSION_TEST = `import { expect, test } from '@playwright/test';

import { runPromiseScenario } from '../support/scenario.js';

test('hydrates preference before collector startup', async ({ page, request }, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'regression-off-001',
    userId: 'demo-user-regression-off',
  });
  const events = result.evidence.timestamps.clientTimeline.map((entry) => entry.event);
  const hydrationCompleted = events.indexOf('preference_hydration_completed');
  const collectorStarted = events.indexOf('collector_started');
  expect(hydrationCompleted).toBeGreaterThanOrEqual(0);
  expect(collectorStarted).toBeGreaterThanOrEqual(0);
  expect(hydrationCompleted).toBeLessThan(collectorStarted);
  expect(result.browserErrors).toEqual([]);
  expect(result.evidence.request.activityPayloads).toEqual([]);
  expect(result.evidence.backend.activityReceipts).toEqual([]);
  expect(result.evaluation.violations).toEqual([]);
  expect(result.evidence.journey.reloadObserved).toBe(true);
  expect(result.evidence.recommendation.source).toBe('contextual');
});
`;

interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly handle: DisposableWorktree;
}

const roots = new Set<string>();
const handles = new Set<DisposableWorktree>();

afterEach(async () => {
  for (const handle of [...handles]) {
    try {
      await cleanupDisposableWorktree(handle);
    } catch (error) {
      if (
        !(error instanceof WorktreeBoundaryError) ||
        error.code !== 'worktree_already_cleaned'
      ) {
        throw error;
      }
    } finally {
      handles.delete(handle);
    }
  }
  for (const root of [...roots]) {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-repair-unit-'));
  roots.add(root);
  const repo = join(root, 'repository');
  await mkdir(join(repo, 'src', 'client'), { recursive: true });
  await runGit(repo, ['init', '--initial-branch=main']);
  await runGit(repo, ['config', 'user.name', 'PromiseProof Unit Tests']);
  await runGit(repo, ['config', 'user.email', 'tests@promiseproof.invalid']);
  await writeFile(join(repo, '.gitignore'), 'ignored.tmp\n', 'utf8');
  await writeFile(join(repo, 'src', 'client', 'main.ts'), BASE_SOURCE, 'utf8');
  await runGit(repo, ['add', '.gitignore', 'src/client/main.ts']);
  await runGit(repo, ['commit', '-m', 'test: seed repository']);

  const handle = await createDisposableWorktree(repo, { tempParent: root });
  handles.add(handle);
  return { root, repo, handle };
}

async function applyValidChanges(handle: DisposableWorktree): Promise<void> {
  await writeFile(
    join(handle.worktreePath, 'src', 'client', 'main.ts'),
    REPAIRED_SOURCE,
    'utf8',
  );
  await mkdir(join(handle.worktreePath, 'tests', 'regression'), {
    recursive: true,
  });
  await writeFile(
    join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    ),
    REGRESSION_TEST,
    'utf8',
  );
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(
      error instanceof RepairDiffValidationError ||
        error instanceof WorktreeBoundaryError,
      true,
    );
    assert.equal((error as { readonly code: string }).code, code);
    return true;
  });
}

test('accepts only the two-file unstaged repair and includes the untracked diff', async () => {
  const { repo, handle } = await createFixture();
  const refsBefore = await captureRefState(repo);
  await applyValidChanges(handle);

  const inspection = await inspectDisposableWorktree(handle);
  assert.deepEqual(
    inspection.status.map((entry) => [
      entry.indexStatus,
      entry.worktreeStatus,
      entry.path,
    ]),
    [
      [' ', 'M', 'src/client/main.ts'],
      ['?', '?', 'tests/regression/initialization-order.spec.ts'],
    ],
  );
  assert.match(
    inspection.combinedUnstagedPatch,
    /diff --git a\/tests\/regression\/initialization-order\.spec\.ts/u,
  );

  const validated = await validateRepairDiff(handle);
  assert.equal(validated.baseHead, handle.repository.baseHead);
  assert.equal(validated.patchBytes <= MAX_REPAIR_PATCH_BYTES, true);
  assert.equal(validated.totalChangedLines <= MAX_REPAIR_CHANGED_LINES, true);
  assert.match(validated.patchSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(equalRefStates(refsBefore, await captureRefState(repo)), true);
  await verifyDisposableWorktree(handle);
});

test('Git commands ignore inherited Git redirection environment variables', async () => {
  const { root, repo } = await createFixture();
  const originalGitDirectory = process.env.GIT_DIR;
  process.env.GIT_DIR = join(root, 'attacker-controlled-git-dir');
  try {
    const topLevel = (
      await runGit(repo, ['rev-parse', '--show-toplevel'])
    ).stdout.trim();
    assert.equal(resolve(topLevel), resolve(repo));
  } finally {
    if (originalGitDirectory === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = originalGitDirectory;
    }
  }
});

test('reopens a persisted worktree handle only inside its registered temp boundary', async () => {
  const { root, repo, handle } = await createFixture();
  const reopened = await reopenDisposableWorktree(repo, handle.worktreePath, {
    tempParent: root,
  });
  handles.delete(handle);
  handles.add(reopened);
  assert.equal(reopened.worktreePath, handle.worktreePath);
  assert.equal(reopened.repository.baseHead, handle.repository.baseHead);
  await verifyDisposableWorktree(reopened);
  await cleanupDisposableWorktree(reopened);
  handles.delete(reopened);
});

test('refuses to reopen a registered repair-prefixed checkout without an exact UUID root', async () => {
  const { root, repo, handle } = await createFixture();
  const foreignRoot = join(handle.tempBase, 'repair-not-a-uuid');
  const foreignCheckout = join(foreignRoot, 'checkout');
  await runGit(repo, [
    'worktree',
    'add',
    '--detach',
    foreignCheckout,
    handle.repository.baseHead,
  ]);
  try {
    await expectErrorCode(
      reopenDisposableWorktree(repo, foreignCheckout, { tempParent: root }),
      'unsafe_reopened_path',
    );
  } finally {
    await runGit(repo, ['worktree', 'remove', '--force', foreignCheckout]);
    await rm(foreignRoot, { force: true, recursive: true });
  }
});

test('rejects semantic bypasses, bidi controls, and hard-linked repair files', async (context) => {
  await context.test('test bypass', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(
        handle.worktreePath,
        'tests',
        'regression',
        'initialization-order.spec.ts',
      ),
      `${REGRESSION_TEST}\ntest.skip(true, 'bypass');\n`,
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'unsafe_regression_test');
  });

  await context.test('bare Node built-in import', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regressionPath = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await writeFile(
      regressionPath,
      REGRESSION_TEST.replace(
        "import { runPromiseScenario } from '../support/scenario.js';",
        "import { readFile } from 'fs/promises';",
      ),
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'unsafe_regression_import_or_shape',
    );
  });

  await context.test('process global', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regressionPath = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await writeFile(
      regressionPath,
      REGRESSION_TEST.replace(
        '  const result = await runPromiseScenario',
        '  const environment = process.env;\n  const result = await runPromiseScenario',
      ),
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'unsafe_regression_dataflow');
  });

  await context.test('fixture alias default initializer', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regressionPath = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await writeFile(
      regressionPath,
      REGRESSION_TEST.replace(
        'async ({ page, request }, testInfo)',
        "async ({ proxy: page = process.getBuiltinModule('fs'), request }, testInfo)",
      ),
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'unsafe_regression_fixtures',
    );
  });

  await context.test('vacuous timeline comparison', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regressionPath = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await writeFile(
      regressionPath,
      REGRESSION_TEST.replace(
        "const hydrationCompleted = events.indexOf('preference_hydration_completed');",
        'const hydrationCompleted = 0;',
      ).replace(
        "const collectorStarted = events.indexOf('collector_started');",
        'const collectorStarted = 1;',
      ),
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'unsafe_regression_dataflow');
  });

  await context.test('comment-only evidence assertions', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regressionPath = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await writeFile(
      regressionPath,
      `import { expect, test } from '@playwright/test';

import { runPromiseScenario } from '../support/scenario.js';

test('comment tokens are not evidence', async ({ page, request }, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'regression-off-001',
    userId: 'demo-user-regression-off',
  });
  const events = result.evidence.timestamps.clientTimeline.map((entry) => entry.event);
  const hydrationCompleted = events.indexOf('preference_hydration_completed');
  const collectorStarted = events.indexOf('collector_started');
  // browserErrors activityPayloads activityReceipts evaluation.violations
  // reloadObserved recommendation.source contextual
  // preference_hydration_completed collector_started
  expect(result).toBe(result);
});
`,
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'regression_assertion_incomplete',
    );
  });

  await context.test('extra application mutation', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(handle.worktreePath, 'src', 'client', 'main.ts'),
      `${REPAIRED_SOURCE}\n// unrelated model-authored change\n`,
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'source_repair_outside_boundary',
    );
  });

  await context.test('stale seeded-race explanation retained after reorder', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(handle.worktreePath, 'src', 'client', 'main.ts'),
      REPAIRED_SOURCE.replace(
        '      await hydratePreference();',
        '      // The seeded race means hydration cannot begin until an activity receipt has already returned.\n      await hydratePreference();',
      ),
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'source_repair_not_bounded',
    );
  });

  await context.test('bidi control', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(
        handle.worktreePath,
        'tests',
        'regression',
        'initialization-order.spec.ts',
      ),
      `${REGRESSION_TEST}\n// \u202ereversed\n`,
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'bidi_control');
  });

  await context.test('terminal escape control', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(
        handle.worktreePath,
        'tests',
        'regression',
        'initialization-order.spec.ts',
      ),
      `${REGRESSION_TEST}\n// \u001b[2Jhidden\n`,
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'nonprinting_control');
  });

  await context.test('bare carriage return control', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(
        handle.worktreePath,
        'tests',
        'regression',
        'initialization-order.spec.ts',
      ),
      `${REGRESSION_TEST}\n// before\roverwrite\n`,
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'nonprinting_control');
  });

  await context.test('hard link', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    const regression = join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    await unlink(regression);
    await link(join(handle.worktreePath, 'src', 'client', 'main.ts'), regression);
    await expectErrorCode(validateRepairDiff(handle), 'hard_link');
  });
});

test('rejects path traversal helpers and an unexpected third path', async () => {
  const { handle } = await createFixture();
  assert.throws(
    () => resolveRepositoryPath(handle.worktreePath, '../outside.txt'),
    /Unsafe repository-relative path/u,
  );
  assert.throws(
    () => resolveRepositoryPath(handle.worktreePath, 'C:/outside.txt'),
    /Unsafe repository-relative path/u,
  );

  await applyValidChanges(handle);
  await writeFile(
    join(handle.worktreePath, 'src', 'client', 'unexpected.ts'),
    'export const unexpected = true;\n',
    'utf8',
  );
  await expectErrorCode(validateRepairDiff(handle), 'unexpected_path');
});

test('rejects a detached commit even when it does not move a named ref', async () => {
  const { handle } = await createFixture();
  await applyValidChanges(handle);
  await runGit(handle.worktreePath, ['add', '--all']);
  await runGit(handle.worktreePath, ['commit', '-m', 'forbidden repair commit']);

  await expectErrorCode(validateRepairDiff(handle), 'worktree_head_changed');
});

test('rejects any shared Git ref mutation', async () => {
  const { handle } = await createFixture();
  await applyValidChanges(handle);
  await runGit(handle.worktreePath, ['branch', 'forbidden-ref']);

  await expectErrorCode(validateRepairDiff(handle), 'repository_refs_changed');
});

test('rejects staged changes', async () => {
  const { handle } = await createFixture();
  await applyValidChanges(handle);
  await runGit(handle.worktreePath, ['add', 'src/client/main.ts']);

  await expectErrorCode(validateRepairDiff(handle), 'staged_changes');
});

test('rejects a patch larger than 32 KiB even with few changed lines', async () => {
  const { handle } = await createFixture();
  const giantSource = `export const bounded = '${'x'.repeat(
    MAX_REPAIR_PATCH_BYTES + 1024,
  )}';\n`;
  await writeFile(
    join(handle.worktreePath, 'src', 'client', 'main.ts'),
    giantSource,
    'utf8',
  );
  await mkdir(join(handle.worktreePath, 'tests', 'regression'), {
    recursive: true,
  });
  await writeFile(
    join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    ),
    REGRESSION_TEST,
    'utf8',
  );

  await expectErrorCode(validateRepairDiff(handle), 'patch_too_large');
});

test('rejects more than 160 added and deleted lines', async () => {
  const { handle } = await createFixture();
  const manyLines = Array.from(
    { length: MAX_REPAIR_CHANGED_LINES + 1 },
    (_, index) => `export const line${index} = ${index};`,
  ).join('\n');
  await writeFile(
    join(handle.worktreePath, 'src', 'client', 'main.ts'),
    `${manyLines}\n`,
    'utf8',
  );
  await mkdir(join(handle.worktreePath, 'tests', 'regression'), {
    recursive: true,
  });
  await writeFile(
    join(
      handle.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    ),
    'export {};\n',
    'utf8',
  );

  await expectErrorCode(validateRepairDiff(handle), 'too_many_changed_lines');
});

test('rejects missing paths, deletions, and ignored artifacts', async (context) => {
  await context.test('missing regression test', async () => {
    const { handle } = await createFixture();
    await writeFile(
      join(handle.worktreePath, 'src', 'client', 'main.ts'),
      REPAIRED_SOURCE,
      'utf8',
    );
    await expectErrorCode(validateRepairDiff(handle), 'missing_required_change');
  });

  await context.test('deleted source file', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await unlink(join(handle.worktreePath, 'src', 'client', 'main.ts'));
    await expectErrorCode(validateRepairDiff(handle), 'wrong_source_status');
  });

  await context.test('ignored artifact', async () => {
    const { handle } = await createFixture();
    await applyValidChanges(handle);
    await writeFile(
      join(handle.worktreePath, 'ignored.tmp'),
      'must not be hidden from review\n',
      'utf8',
    );
    await expectErrorCode(
      validateRepairDiff(handle),
      'unexpected_ignored_path',
    );
  });
});

test('safe cleanup rejects forged handles and removes only its created root', async () => {
  const { root, repo, handle } = await createFixture();
  const sentinel = join(root, 'must-survive.txt');
  await writeFile(sentinel, 'safe\n', 'utf8');

  const forged = {
    ...handle,
    tempRoot: root,
    worktreePath: repo,
  } as DisposableWorktree;
  await expectErrorCode(
    cleanupDisposableWorktree(forged),
    'unrecognized_worktree_handle',
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'safe\n');

  const createdRoot = handle.tempRoot;
  await cleanupDisposableWorktree(handle);
  handles.delete(handle);
  await assert.rejects(access(createdRoot), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'safe\n');
  await access(repo);

  const worktreeList = (
    await runGit(repo, ['worktree', 'list', '--porcelain'])
  ).stdout;
  assert.equal(worktreeList.includes(createdRoot), false);
});
