import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { runGit } from '../../src/repair/git.js';
import {
  WorktreeBoundaryError,
  cleanupDisposableWorktree,
  cleanupPersistedDisposableWorktreeIntent,
  cleanupPlannedDisposableWorktree,
  materializeDisposableWorktree,
  planDisposableWorktree,
  repairWorktreeAllocationId,
  verifyDisposableWorktree,
  type DisposableWorktree,
  type PlannedDisposableWorktree,
} from '../../src/repair/worktree.js';

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

async function createRepositoryFixture(): Promise<{
  readonly root: string;
  readonly repo: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-plan-unit-'));
  roots.add(root);
  const repo = join(root, 'repository');
  await mkdir(repo);
  await runGit(repo, ['init', '--initial-branch=main']);
  await runGit(repo, ['config', 'user.name', 'PromiseProof Unit Tests']);
  await runGit(repo, ['config', 'user.email', 'tests@promiseproof.invalid']);
  await writeFile(join(repo, 'seed.txt'), 'planned worktree\n', 'utf8');
  await runGit(repo, ['add', 'seed.txt']);
  await runGit(repo, ['commit', '-m', 'test: seed repository']);
  return { root, repo };
}

async function expectBoundaryCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal(error instanceof WorktreeBoundaryError, true);
    assert.equal((error as WorktreeBoundaryError).code, code);
    return true;
  });
}

test('freezes and exposes an exact UUID path before creating the planned root', async () => {
  const { root, repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo, { tempParent: root });

  assert.equal(Object.isFrozen(plan), true);
  assert.match(
    plan.allocationId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.equal(plan.tempRoot.endsWith(`repair-${plan.allocationId}`), true);
  assert.equal(plan.worktreePath, join(plan.tempRoot, 'checkout'));
  await assert.rejects(access(plan.tempRoot), { code: 'ENOENT' });
  await assert.rejects(access(plan.worktreePath), { code: 'ENOENT' });

  const persistedIntent = JSON.parse(JSON.stringify(plan)) as {
    readonly allocationId: string;
    readonly tempRoot: string;
    readonly worktreePath: string;
  };
  assert.equal(persistedIntent.allocationId, plan.allocationId);
  assert.equal(persistedIntent.tempRoot, plan.tempRoot);
  assert.equal(persistedIntent.worktreePath, plan.worktreePath);
  assert.equal(
    repairWorktreeAllocationId(plan.allocationId, 'candidate'),
    plan.allocationId,
  );
  const verificationAllocation = repairWorktreeAllocationId(
    plan.allocationId,
    'verification',
  );
  assert.match(
    verificationAllocation,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  assert.notEqual(verificationAllocation, plan.allocationId);
  assert.equal(
    repairWorktreeAllocationId(plan.allocationId, 'verification'),
    verificationAllocation,
  );

  await cleanupPlannedDisposableWorktree(plan);
  await expectBoundaryCode(
    materializeDisposableWorktree(plan),
    'worktree_plan_already_consumed',
  );
});

test('rejects a forged plan while leaving the authentic plan usable', async () => {
  const { root, repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo, { tempParent: root });
  const forged = { ...plan } as PlannedDisposableWorktree;

  await expectBoundaryCode(
    materializeDisposableWorktree(forged),
    'unrecognized_worktree_plan',
  );
  const handle = await materializeDisposableWorktree(plan);
  handles.add(handle);
  assert.equal(handle.tempRoot, plan.tempRoot);
  assert.equal(handle.worktreePath, plan.worktreePath);
  await verifyDisposableWorktree(handle);
});

test('materializes exactly the planned path and safely removes only that root', async () => {
  const { root, repo } = await createRepositoryFixture();
  const sentinel = join(root, 'must-survive.txt');
  await writeFile(sentinel, 'safe\n', 'utf8');
  const plan = await planDisposableWorktree(repo, { tempParent: root });

  const handle = await materializeDisposableWorktree(plan);
  handles.add(handle);
  assert.equal(handle.tempRoot, plan.tempRoot);
  assert.equal(handle.worktreePath, plan.worktreePath);
  await access(handle.worktreePath);

  await cleanupDisposableWorktree(handle);
  handles.delete(handle);
  await assert.rejects(access(plan.tempRoot), { code: 'ENOENT' });
  assert.equal(await readFile(sentinel, 'utf8'), 'safe\n');
  const worktreeList = (
    await runGit(repo, ['worktree', 'list', '--porcelain'])
  ).stdout;
  assert.equal(worktreeList.includes(plan.tempRoot), false);
});

test('rejects a collision without deleting the foreign path', async () => {
  const { root, repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo, { tempParent: root });
  await mkdir(plan.tempRoot);
  const sentinel = join(plan.tempRoot, 'foreign.txt');
  await writeFile(sentinel, 'do not remove\n', 'utf8');

  await expectBoundaryCode(
    materializeDisposableWorktree(plan),
    'planned_path_collision',
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'do not remove\n');
  const worktreeList = (
    await runGit(repo, ['worktree', 'list', '--porcelain'])
  ).stdout;
  assert.equal(worktreeList.includes(plan.worktreePath), false);
});

test('revalidates the repository snapshot before creating the planned root', async () => {
  const { root, repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo, { tempParent: root });
  await runGit(repo, ['branch', 'changed-after-plan']);

  await expectBoundaryCode(
    materializeDisposableWorktree(plan),
    'repository_snapshot_changed',
  );
  await assert.rejects(access(plan.tempRoot), { code: 'ENOENT' });
});

test('reconciles a persisted plan whose UUID root was never created', async () => {
  const { repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo);

  assert.equal(
    await cleanupPersistedDisposableWorktreeIntent(repo, plan.worktreePath),
    'absent',
  );
  await assert.rejects(access(plan.tempRoot), { code: 'ENOENT' });
  assert.equal(
    (await runGit(repo, ['worktree', 'list', '--porcelain'])).stdout.includes(
      plan.worktreePath,
    ),
    false,
  );

  await cleanupPlannedDisposableWorktree(plan);
});

test('removes only an empty persisted UUID root created before materialization', async () => {
  const { repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo);
  await mkdir(plan.tempRoot);

  assert.equal(
    await cleanupPersistedDisposableWorktreeIntent(repo, plan.worktreePath),
    'unmaterialized',
  );
  await assert.rejects(access(plan.tempRoot), { code: 'ENOENT' });
  assert.equal(
    (await runGit(repo, ['worktree', 'list', '--porcelain'])).stdout.includes(
      plan.worktreePath,
    ),
    false,
  );

  await cleanupPlannedDisposableWorktree(plan);
});

test('refuses to remove a nonempty unregistered persisted UUID root', async () => {
  const { repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo);
  const sentinel = join(plan.tempRoot, 'foreign.txt');
  await mkdir(plan.tempRoot);
  await writeFile(sentinel, 'retain me\n', 'utf8');

  await expectBoundaryCode(
    cleanupPersistedDisposableWorktreeIntent(repo, plan.worktreePath),
    'unsafe_cleanup_target',
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'retain me\n');
  await rm(plan.tempRoot, { force: true, recursive: true });
  await cleanupPlannedDisposableWorktree(plan);
});

test('rejects a persisted checkout path without an exact UUID allocation root', async () => {
  const { repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo);
  const malformed = join(plan.tempBase, 'repair-not-a-uuid', 'checkout');

  await expectBoundaryCode(
    cleanupPersistedDisposableWorktreeIntent(repo, malformed),
    'unsafe_persisted_intent',
  );
  await cleanupPlannedDisposableWorktree(plan);
});

test('refuses to call a missing checkout clean while Git still registers it', async () => {
  const { repo } = await createRepositoryFixture();
  const plan = await planDisposableWorktree(repo);
  const handle = await materializeDisposableWorktree(plan);
  handles.add(handle);
  await rm(handle.worktreePath, { force: true, recursive: true });

  await expectBoundaryCode(
    cleanupPersistedDisposableWorktreeIntent(repo, handle.worktreePath),
    'worktree_still_registered',
  );
  await runGit(repo, ['worktree', 'remove', '--force', handle.worktreePath]);
  await rm(handle.tempRoot, { force: true, recursive: true });
  handles.delete(handle);
});
