import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
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

import {
  REPAIR_LOCAL_STATE_VERSION,
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  readRepairLifecycle,
  sha256Bytes,
  writeLocalRepairState,
  type LocalRepairStateV1,
  type RepairStateName,
} from '../../src/repair/artifact.js';
import type { RaceRepairCandidateV1 } from '../../src/repair/contracts.js';
import {
  FOUNDATION_POLICY_VERSION,
  FROZEN_CRITICAL_PATHS,
  MILESTONE_03_COMMIT,
  MILESTONE_03_TAG,
} from '../../src/repair/foundation.js';
import {
  resolveCleanRepository,
  runGit,
  type CleanRepositorySnapshot,
} from '../../src/repair/git.js';
import type { RepairProviderResult } from '../../src/repair/provider.js';
import {
  readBoundRepairState,
  retryRepairCleanup,
} from '../../src/repair/repair-flow.js';
import {
  RepairOrchestrationError,
  acquireRepairLock,
  recoverStaleRepairLock,
  resolveRepairRunsRoot,
} from '../../src/repair/runner.js';
import {
  REPAIR_VERIFICATION_RECEIPT_VERSION,
  type RepairVerificationReceiptV1,
  type SafeCommandReceipt,
  type ScenarioEvidenceSummary,
  type VerificationStageId,
} from '../../src/repair/verification.js';
import {
  WorktreeBoundaryError,
  cleanupDisposableWorktree,
  cleanupPlannedDisposableWorktree,
  createDisposableWorktree,
  planDisposableWorktree,
  repairWorktreeAllocationId,
  type DisposableWorktree,
} from '../../src/repair/worktree.js';

interface RepositoryFixture {
  readonly root: string;
  readonly repo: string;
  readonly repository: CleanRepositorySnapshot;
  readonly baseTree: string;
  readonly sentinelPath: string;
}

const roots = new Set<string>();
const worktrees = new Set<DisposableWorktree>();
const VERIFICATION_STAGE_IDS = [
  'install_dependencies',
  'build',
  'race_off_single',
  'race_on_single',
  'race_off_repeat_5',
  'race_on_repeat_5',
  'propagation_expected_red',
  'propagation_green',
  'startup_regression',
] as const satisfies readonly VerificationStageId[];

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  for (const handle of [...worktrees]) {
    try {
      if (await pathExists(handle.worktreePath)) {
        await cleanupDisposableWorktree(handle);
      }
    } catch (error) {
      if (
        !(error instanceof WorktreeBoundaryError) ||
        error.code !== 'worktree_already_cleaned'
      ) {
        throw error;
      }
    } finally {
      worktrees.delete(handle);
    }
  }
  for (const root of [...roots]) {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

async function createRepositoryFixture(): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-recovery-unit-'));
  roots.add(root);
  const repo = join(root, 'repository');
  const sentinelPath = join(repo, 'must-survive.txt');
  await mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '--initial-branch=main']);
  await runGit(repo, ['config', 'user.name', 'PromiseProof Recovery Tests']);
  await runGit(repo, ['config', 'user.email', 'tests@promiseproof.invalid']);
  await writeFile(join(repo, '.gitignore'), 'test-results/\n', 'utf8');
  await writeFile(sentinelPath, 'retained sentinel\n', 'utf8');
  await runGit(repo, ['add', '.gitignore', 'must-survive.txt']);
  await runGit(repo, ['commit', '-m', 'test: seed recovery repository']);
  const repository = await resolveCleanRepository(repo);
  const baseTree = (
    await runGit(repo, ['rev-parse', '--verify', 'HEAD^{tree}'])
  ).stdout.trim();
  return { root, repo, repository, baseTree, sentinelPath };
}

function eligibilityFixture(): RaceRepairCandidateV1 {
  return {
    schemaVersion: 'promiseproof.race-repair-candidate.v1',
    candidateKind: 'startup_order_repair',
    promiseAuthority: 'deterministic_typescript_and_playwright_only',
    source: {
      receiptSchemaVersion: 'promiseproof.live-stability-receipt.v1',
      canonicalReceiptSha256: '1'.repeat(64),
      sourceSnapshotSha256: '2'.repeat(64),
      sourceSnapshotMeaning:
        'pre_run_and_post_run_canonical_file_manifest_match',
      artifactIntegrityMeaning:
        'canonical_sha256_consistency_not_provider_origin_attestation',
    },
    evidence: {
      evidenceSignature: 'identifiable_activity_leak',
      violationCode: 'PP_IDENTIFIABLE_EVENT_LEAK',
      selectedReplay: 'inspect_startup_order',
      dossierSha256: '3'.repeat(64),
      investigationIdCohortSha256: '4'.repeat(64),
      responseIdCohortSha256: '5'.repeat(64),
      canonicalArtifactSha256s: [
        '6'.repeat(64),
        'a'.repeat(64),
        'b'.repeat(64),
      ],
      leadingHypothesisIds: ['h1', 'h1', 'h1'],
      returnedModels: [
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-sol',
      ],
      runCount: 3,
      responseCount: 6,
      facts: {
        failedClauseId: 'no_identifiable_activity',
        identifiableActivityRequests: 1,
        identifiableActivityReceipts: 1,
        collectorBeforeHydration: true,
        activityBeforePreferenceRead: true,
      },
    },
    deterministicChecks: {
      stableDossierAcrossRuns: true,
      uniqueInvestigationIds: true,
      uniqueResponseIds: true,
      completedAllowlistedResponsesOnly: true,
      modelVerdictUsed: false,
    },
  };
}

function providerFixture(): RepairProviderResult {
  return {
    kind: 'offline-deterministic',
    requestedModel: 'offline-codex-fixture',
    sdkVersion: 'offline-fixture-v1',
    cliVersion: 'offline-fixture-v1',
    threadId: `offline_${randomUUID().replaceAll('-', '')}`,
    turnsUsed: 1,
    summary: {
      schemaVersion: 'promiseproof.codex-repair-summary.v1',
      intent: 'candidate_patch_prepared',
      changedFiles: [
        { path: 'src/client/main.ts', purpose: 'source_repair' },
        {
          path: 'tests/regression/initialization-order.spec.ts',
          purpose: 'regression_test',
        },
      ],
      constraintCodes: [
        'source_and_regression_only',
        'no_contract_changes',
        'human_review_required',
        'playwright_owns_verdict',
      ],
    },
    finalResponseSha256: 'c'.repeat(64),
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    },
    events: {
      eventCount: 1,
      serializedBytesObserved: 1,
      eventTypeCounts: { 'turn.completed': 1 },
      completedItemTypeCounts: { file_change: 1 },
      completedCommandCount: 0,
      completedFileChangeCount: 1,
      observedFilePaths: [
        'src/client/main.ts',
        'tests/regression/initialization-order.spec.ts',
      ],
      sanitizedSequenceSha256: 'd'.repeat(64),
    },
    timing: {
      startedAt: '2026-07-15T10:00:00.000Z',
      completedAt: '2026-07-15T10:00:01.000Z',
      totalMs: 1_000,
    },
    validationCodes: ['PP_REPAIR_OFFLINE_PROVIDER_ACCEPTED'],
  };
}

function stateFixture(input: {
  readonly fixture: RepositoryFixture;
  readonly repairId: string;
  readonly state: RepairStateName;
  readonly candidateWorktreePath: string;
  readonly verificationWorktreePath?: string | null;
  readonly provider?: RepairProviderResult | null;
  readonly patch?: LocalRepairStateV1['patch'];
  readonly approvalSha256?: string | null;
}): LocalRepairStateV1 {
  const createdAt = '2026-07-15T10:00:00.000Z';
  const artifactDirectory = join(
    input.fixture.repo,
    'test-results',
    'repair-runs',
    input.repairId,
  );
  const candidateTempRoot = join(input.candidateWorktreePath, '..');
  return {
    schemaVersion: REPAIR_LOCAL_STATE_VERSION,
    repairId: input.repairId,
    state: input.state,
    createdAt,
    updatedAt: createdAt,
    projectRoot: input.fixture.repo,
    artifactDirectory,
    lifecyclePath: join(artifactDirectory, 'lifecycle.json'),
    patchPath: join(artifactDirectory, 'candidate.patch'),
    approvalPath: join(artifactDirectory, 'human-decision.json'),
    candidateWorktreePath: input.candidateWorktreePath,
    verificationWorktreePath: input.verificationWorktreePath ?? null,
    codexHomePath: join(candidateTempRoot, 'codex-home'),
    toolTempPath: join(candidateTempRoot, 'tool-temp'),
    baseCommit: input.fixture.repository.baseHead,
    baseTree: input.fixture.baseTree,
    baseHeadRef: input.fixture.repository.headRef,
    baseRefState: input.fixture.repository.refState,
    milestoneTag: MILESTONE_03_TAG,
    frozenFoundation: {
      policyVersion: FOUNDATION_POLICY_VERSION,
      checkpointTag: MILESTONE_03_TAG,
      checkpointCommit: MILESTONE_03_COMMIT,
      baseCommit: input.fixture.repository.baseHead,
      baseTree: input.fixture.baseTree,
      changedPathsFromCheckpoint: ['src/repair/artifact.ts'],
      allOtherCheckpointPathsUnchanged: true,
      criticalFiles: FROZEN_CRITICAL_PATHS.map((path) => ({
        path,
        checkpointBlobId: 'e'.repeat(40),
        baseBlobId: 'e'.repeat(40),
        sha256: 'f'.repeat(64),
      })),
    },
    eligibility: eligibilityFixture(),
    promptEnvelopeSha256: '0'.repeat(64),
    provider:
      input.provider === undefined ? providerFixture() : input.provider,
    providerFailure: null,
    failure: null,
    patch:
      input.patch === undefined
        ? {
            sha256: '1'.repeat(64),
            bytes: 128,
            additions: 2,
            deletions: 1,
            changedFiles: [
              {
                path: 'src/client/main.ts',
                status: 'modified',
                beforeSha256: '2'.repeat(64),
                afterSha256: '3'.repeat(64),
              },
              {
                path: 'tests/regression/initialization-order.spec.ts',
                status: 'added',
                beforeSha256: null,
                afterSha256: '4'.repeat(64),
              },
            ],
          }
        : input.patch,
    approvalSha256:
      input.approvalSha256 === undefined
        ? '5'.repeat(64)
        : input.approvalSha256,
    verificationReceiptPath: null,
    verificationReceiptSha256: null,
  };
}

async function persistStateAndLifecycle(
  state: LocalRepairStateV1,
  states: readonly RepairStateName[],
): Promise<string> {
  await mkdir(state.artifactDirectory, { recursive: true });
  for (const lifecycleState of states) {
    await appendRepairLifecycle(
      state.lifecyclePath,
      state.repairId,
      lifecycleState,
      { recoveryFixture: true, lifecycleState },
    );
  }
  const statePath = join(state.artifactDirectory, 'state.json');
  await writeLocalRepairState(statePath, state);
  return statePath;
}

function commandReceipt(id: VerificationStageId): SafeCommandReceipt {
  const emptyOutputSha256 = sha256Bytes('');
  return {
    id,
    exitCode: id === 'propagation_expected_red' ? 1 : 0,
    signal: null,
    startedAt: '2026-07-15T10:01:00.000Z',
    completedAt: '2026-07-15T10:01:00.001Z',
    durationMs: 1,
    timedOut: false,
    outputLimitExceeded: false,
    spawnError: null,
    stdoutBytes: 0,
    stdoutSha256: emptyOutputSha256,
    stderrBytes: 0,
    stderrSha256: emptyOutputSha256,
  };
}

function passingScenario(
  scenario: 'off' | 'on',
  runId: string,
): ScenarioEvidenceSummary {
  const off = scenario === 'off';
  return {
    scenario,
    runId,
    userId: `recovery-${runId}`,
    verdict: 'pass',
    violationCodes: [],
    passedClauseIds: off
      ? [
          'no_identifiable_activity',
          'feed_remains_functional',
          'preference_survives_reload',
        ]
      : ['expected_activity_reaches_service', 'behavioral_feed_functional'],
    failedClauseIds: [],
    identifiableActivityRequests: off ? 0 : 1,
    identifiableActivityReceipts: off ? 0 : 1,
    recommendationSource: off ? 'contextual' : 'behavioral',
    recommendationItemCount: 2,
    uiPreference: scenario,
    storagePreference: scenario,
    backendPreference: scenario,
    reloadObserved: true,
    browserErrorCount: 0,
    artifactSha256: sha256Bytes(`artifact-${runId}`),
  };
}

function propagationExpectedRedScenario(): ScenarioEvidenceSummary {
  return {
    scenario: 'off',
    runId: 'propagation-expected-red',
    userId: 'recovery-propagation-expected-red',
    verdict: 'fail',
    violationCodes: ['PP_PREFERENCE_NOT_PERSISTED'],
    passedClauseIds: [
      'no_identifiable_activity',
      'feed_remains_functional',
    ],
    failedClauseIds: ['preference_survives_reload'],
    identifiableActivityRequests: 0,
    identifiableActivityReceipts: 0,
    recommendationSource: 'contextual',
    recommendationItemCount: 2,
    uiPreference: 'off',
    storagePreference: 'off',
    backendPreference: 'on',
    reloadObserved: true,
    browserErrorCount: 0,
    artifactSha256: sha256Bytes('artifact-propagation-expected-red'),
  };
}

const PREPARATION_INTERRUPTION_CASES = [
  {
    state: 'created',
    lifecycle: ['created'],
    providerRetained: false,
    patchRetained: false,
  },
  {
    state: 'baseline_verified',
    lifecycle: ['created', 'baseline_verified'],
    providerRetained: false,
    patchRetained: false,
  },
  {
    state: 'codex_completed',
    lifecycle: ['created', 'baseline_verified', 'codex_completed'],
    providerRetained: true,
    patchRetained: false,
  },
  {
    state: 'candidate_policy_accepted',
    lifecycle: [
      'created',
      'baseline_verified',
      'codex_completed',
      'candidate_policy_accepted',
    ],
    providerRetained: true,
    patchRetained: true,
  },
] as const satisfies readonly {
  readonly state: RepairStateName;
  readonly lifecycle: readonly RepairStateName[];
  readonly providerRetained: boolean;
  readonly patchRetained: boolean;
}[];

for (const interruption of PREPARATION_INTERRUPTION_CASES) {
  test(`retires an interrupted ${interruption.state} preparation with evidence before cleanup`, async () => {
    const fixture = await createRepositoryFixture();
    const repairId = randomUUID();
    const candidate = await createDisposableWorktree(fixture.repo, {
      allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
    });
    worktrees.add(candidate);
    const completeFixture = stateFixture({
      fixture,
      repairId,
      state: interruption.state,
      candidateWorktreePath: candidate.worktreePath,
    });
    const state: LocalRepairStateV1 = {
      ...completeFixture,
      provider: interruption.providerRetained
        ? completeFixture.provider
        : null,
      patch: interruption.patchRetained ? completeFixture.patch : null,
      approvalSha256: null,
    };
    await persistStateAndLifecycle(state, interruption.lifecycle);

    const recovered = await retryRepairCleanup(fixture.repo, repairId);
    const lifecycle = await readRepairLifecycle(state.lifecyclePath);
    const failure = JSON.parse(
      await readFile(join(state.artifactDirectory, 'failure.json'), 'utf8'),
    ) as Record<string, unknown>;

    assert.equal(recovered.state, 'cleanup_completed');
    assert.equal(recovered.failure?.stage, 'preparation_interrupted');
    assert.equal(recovered.failure?.code, 'PP_REPAIR_PREPARATION_FAILED');
    assert.deepEqual(failure, recovered.failure);
    assert.deepEqual(
      lifecycle.events.map((event) => event.state),
      [...interruption.lifecycle, 'evidence_saved', 'cleanup_completed'],
    );
    assert.equal(await pathExists(candidate.worktreePath), false);
    assert.equal(
      (
        await runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
      ).stdout.includes(candidate.worktreePath),
      false,
    );
    assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
  });
}

for (const plannedRootState of ['absent', 'empty'] as const) {
  test(`retires a created preparation whose persisted worktree intent root is ${plannedRootState}`, async () => {
    const fixture = await createRepositoryFixture();
    const repairId = randomUUID();
    const plan = await planDisposableWorktree(fixture.repo, {
      allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
    });
    if (plannedRootState === 'empty') {
      await mkdir(plan.tempRoot);
    }
    const state = stateFixture({
      fixture,
      repairId,
      state: 'created',
      candidateWorktreePath: plan.worktreePath,
      provider: null,
      patch: null,
      approvalSha256: null,
    });
    await persistStateAndLifecycle(state, ['created']);

    const recovered = await retryRepairCleanup(fixture.repo, repairId);
    const lifecycle = await readRepairLifecycle(state.lifecyclePath);

    assert.equal(recovered.state, 'cleanup_completed');
    assert.equal(recovered.failure?.stage, 'preparation_interrupted');
    assert.equal(recovered.failure?.code, 'PP_REPAIR_PREPARATION_FAILED');
    assert.deepEqual(
      lifecycle.events.map((event) => event.state),
      ['created', 'evidence_saved', 'cleanup_completed'],
    );
    assert.equal(await pathExists(plan.tempRoot), false);
    assert.equal(await pathExists(plan.worktreePath), false);
    assert.equal(
      (
        await runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
      ).stdout.includes(plan.worktreePath),
      false,
    );
    assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');

    await cleanupPlannedDisposableWorktree(plan);
  });
}

test('rejects self-consistent state that is not bound to the caller repository and canonical state path', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const plan = await planDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
  const original = stateFixture({
    fixture,
    repairId,
    state: 'created',
    candidateWorktreePath: plan.worktreePath,
    provider: null,
    patch: null,
    approvalSha256: null,
  });
  const forgedProjectRoot = join(fixture.root, 'different-repository');
  const forgedArtifactDirectory = join(
    forgedProjectRoot,
    'test-results',
    'repair-runs',
    repairId,
  );
  const forged: LocalRepairStateV1 = {
    ...original,
    projectRoot: forgedProjectRoot,
    artifactDirectory: forgedArtifactDirectory,
    lifecyclePath: join(forgedArtifactDirectory, 'lifecycle.json'),
    patchPath: join(forgedArtifactDirectory, 'candidate.patch'),
    approvalPath: join(forgedArtifactDirectory, 'human-decision.json'),
  };
  const actualArtifactDirectory = join(
    fixture.repo,
    'test-results',
    'repair-runs',
    repairId,
  );
  const actualStatePath = join(actualArtifactDirectory, 'state.json');
  await mkdir(actualArtifactDirectory, { recursive: true });
  await writeLocalRepairState(actualStatePath, forged);

  await assert.rejects(
    readBoundRepairState(fixture.repo, repairId),
    /PP_REPAIR_STATE_BINDING_INVALID/u,
  );
  await assert.rejects(
    retryRepairCleanup(fixture.repo, repairId),
    /PP_REPAIR_STATE_BINDING_INVALID/u,
  );
  assert.equal(await pathExists(plan.tempRoot), false);
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
  await cleanupPlannedDisposableWorktree(plan);
});

test('rejects state that points cleanup at another valid repair allocation', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const otherRepairId = randomUUID();
  const candidatePath = join(
    fixture.root,
    `repair-${otherRepairId}`,
    'checkout',
  );
  const state = stateFixture({
    fixture,
    repairId,
    state: 'created',
    candidateWorktreePath: candidatePath,
    provider: null,
    patch: null,
    approvalSha256: null,
  });
  const statePath = join(state.artifactDirectory, 'state.json');
  await mkdir(state.artifactDirectory, { recursive: true });
  await writeLocalRepairState(statePath, state);

  await assert.rejects(
    retryRepairCleanup(fixture.repo, repairId),
    /PP_REPAIR_STATE_BINDING_INVALID/u,
  );
  assert.equal(await pathExists(candidatePath), false);
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
});

test('refuses to recover a lock whose live owner still exists', async () => {
  const fixture = await createRepositoryFixture();
  const lock = await acquireRepairLock(fixture.repo);
  try {
    await assert.rejects(
      recoverStaleRepairLock(fixture.repo, { minimumAgeMs: 0 }),
      (error: unknown) => {
        assert.equal(error instanceof RepairOrchestrationError, true);
        assert.equal(
          (error as RepairOrchestrationError).code,
          'PP_REPAIR_LOCK_OWNER_ALIVE',
        );
        return true;
      },
    );
    assert.equal(await pathExists(lock.lockPath), true);
    assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
  } finally {
    await lock.release();
  }
});

test('explicitly recovers a dead stale lock without touching neighboring files', async () => {
  const fixture = await createRepositoryFixture();
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.notEqual(child.pid, undefined);
  const deadPid = child.pid!;
  await once(child, 'exit');
  assert.throws(
    () => process.kill(deadPid, 0),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ESRCH',
  );

  const repairRuns = await resolveRepairRunsRoot(fixture.repo);
  const lockPath = join(repairRuns, '.orchestrator.lock');
  const neighborPath = join(repairRuns, 'must-also-survive.json');
  const token = randomUUID();
  await writeFile(
    lockPath,
    `${JSON.stringify({
      token,
      pid: deadPid,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    'utf8',
  );
  await writeFile(neighborPath, '{"retained":true}\n', 'utf8');

  const recovered = await recoverStaleRepairLock(fixture.repo, {
    minimumAgeMs: 30_000,
  });
  assert.equal(recovered.lockPath, lockPath);
  assert.equal(recovered.deadPid, deadPid);
  assert.equal(await pathExists(lockPath), false);
  assert.equal(await readFile(neighborPath, 'utf8'), '{"retained":true}\n');
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
});

test('reconciles an already completed cleanup without appending a duplicate event', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const absentCandidate = join(fixture.root, `repair-${repairId}`, 'checkout');
  const state = stateFixture({
    fixture,
    repairId,
    state: 'evidence_saved',
    candidateWorktreePath: absentCandidate,
  });
  const statePath = await persistStateAndLifecycle(state, [
    'created',
    'evidence_saved',
    'cleanup_completed',
  ]);
  const lifecycleBefore = await readFile(state.lifecyclePath, 'utf8');

  const first = await retryRepairCleanup(fixture.repo, repairId);
  const second = await retryRepairCleanup(fixture.repo, repairId);
  const lifecycleAfter = await readFile(state.lifecyclePath, 'utf8');
  const retainedLifecycle = await readRepairLifecycle(state.lifecyclePath);

  assert.equal(first.state, 'cleanup_completed');
  assert.equal(second.state, 'cleanup_completed');
  assert.equal(lifecycleAfter, lifecycleBefore);
  assert.deepEqual(
    retainedLifecycle.events.map((event) => event.state),
    ['created', 'evidence_saved', 'cleanup_completed'],
  );
  assert.equal(
    (await readLocalRepairState(statePath)).state,
    'cleanup_completed',
  );
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
});

test('retires an interrupted verification through failure, evidence, and cleanup exactly once', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const candidate = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
  const verification = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'verification'),
  });
  worktrees.add(candidate);
  worktrees.add(verification);
  const state = stateFixture({
    fixture,
    repairId,
    state: 'verification_started',
    candidateWorktreePath: candidate.worktreePath,
    verificationWorktreePath: verification.worktreePath,
  });
  const statePath = await persistStateAndLifecycle(state, [
    'created',
    'baseline_verified',
    'codex_completed',
    'candidate_policy_accepted',
    'awaiting_human_review',
    'human_approved',
    'verification_started',
  ]);

  const recovered = await retryRepairCleanup(fixture.repo, repairId);
  const lifecycleAfterRecovery = await readRepairLifecycle(state.lifecyclePath);
  const lifecycleBytesAfterRecovery = await readFile(state.lifecyclePath, 'utf8');
  const repeated = await retryRepairCleanup(fixture.repo, repairId);

  assert.equal(recovered.state, 'cleanup_completed');
  assert.equal(repeated.state, 'cleanup_completed');
  assert.equal(recovered.failure?.stage, 'verification_interrupted');
  assert.equal(recovered.failure?.code, 'PP_REPAIR_VERIFICATION_FAILED');
  assert.match(
    recovered.failure?.message ?? '',
    /PP_REPAIR_VERIFICATION_INTERRUPTED/u,
  );
  assert.deepEqual(
    lifecycleAfterRecovery.events.map((event) => event.state),
    [
      'created',
      'baseline_verified',
      'codex_completed',
      'candidate_policy_accepted',
      'awaiting_human_review',
      'human_approved',
      'verification_started',
      'verification_failed',
      'evidence_saved',
      'cleanup_completed',
    ],
  );
  assert.equal(
    await readFile(state.lifecyclePath, 'utf8'),
    lifecycleBytesAfterRecovery,
  );
  assert.equal((await readLocalRepairState(statePath)).state, 'cleanup_completed');
  assert.equal(await pathExists(candidate.worktreePath), false);
  assert.equal(await pathExists(verification.worktreePath), false);
  const registered = (
    await runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
  ).stdout;
  assert.equal(registered.includes(candidate.worktreePath), false);
  assert.equal(registered.includes(verification.worktreePath), false);
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
});

test('finalizes a retained authoritative verification pass without inventing a failure', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const candidate = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
  const verification = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'verification'),
  });
  worktrees.add(candidate);
  worktrees.add(verification);
  const initialState = stateFixture({
    fixture,
    repairId,
    state: 'verification_passed',
    candidateWorktreePath: candidate.worktreePath,
    verificationWorktreePath: verification.worktreePath,
  });
  assert.notEqual(initialState.patch, null);
  const retainedPatch = Buffer.from(
    'diff --git a/src/client/main.ts b/src/client/main.ts\n' +
      '--- a/src/client/main.ts\n' +
      '+++ b/src/client/main.ts\n' +
      '@@ -1 +1 @@\n' +
      '-await runStartupCollector();\n' +
      '+await hydratePreference();\n',
    'utf8',
  );
  const retainedPatchSha256 = sha256Bytes(retainedPatch);
  const receiptPath = join(
    initialState.artifactDirectory,
    'verification',
    'verification-receipt.json',
  );
  let state: LocalRepairStateV1 = {
    ...initialState,
    patch: {
      ...initialState.patch!,
      sha256: retainedPatchSha256,
      bytes: retainedPatch.byteLength,
    },
    verificationReceiptPath: receiptPath,
    verificationReceiptSha256: null,
  };
  const raceOffFive = Array.from({ length: 5 }, (_, index) =>
    passingScenario('off', `race-off-repeat-${index + 1}`),
  );
  const raceOnFive = Array.from({ length: 5 }, (_, index) =>
    passingScenario('on', `race-on-repeat-${index + 1}`),
  );
  const receipt: RepairVerificationReceiptV1 = {
    schemaVersion: REPAIR_VERIFICATION_RECEIPT_VERSION,
    repairId,
    verdict: 'pass',
    baseCommit: state.baseCommit,
    approvedPatchSha256: retainedPatchSha256,
    patchBytes: retainedPatch.byteLength,
    verificationWorktreeFresh: true,
    candidateAndVerificationWorktreesDistinct: true,
    patchAppliedByExactDigest: true,
    patchUnchangedAfterVerification: true,
    isolatedPort: 45_123,
    baseUrl: 'http://127.0.0.1:45123',
    startedAt: '2026-07-15T10:01:00.000Z',
    completedAt: '2026-07-15T10:02:00.000Z',
    commands: VERIFICATION_STAGE_IDS.map(commandReceipt),
    checks: {
      build: true,
      raceOffSingle: passingScenario('off', 'race-off-single'),
      raceOnSingle: passingScenario('on', 'race-on-single'),
      raceOffFive,
      raceOnFive,
      propagationExpectedRed: propagationExpectedRedScenario(),
      propagationGreenTestCount: 6,
      startupRegressionTestCount: 1,
    },
    retainedArtifacts: [
      {
        path: 'race-off-single/evidence.json',
        bytes: 1,
        sha256: sha256Bytes('x'),
      },
    ],
  };
  const receiptBody = `${JSON.stringify(receipt, null, 2)}\n`;
  state = {
    ...state,
    verificationReceiptSha256: sha256Bytes(receiptBody),
  };
  const statePath = await persistStateAndLifecycle(state, [
    'created',
    'baseline_verified',
    'codex_completed',
    'candidate_policy_accepted',
    'awaiting_human_review',
    'human_approved',
    'verification_started',
    'verification_passed',
  ]);
  await mkdir(join(state.artifactDirectory, 'verification'), {
    recursive: true,
  });
  await mkdir(join(state.artifactDirectory, 'verification', 'race-off-single'));
  await writeFile(
    join(
      state.artifactDirectory,
      'verification',
      'race-off-single',
      'evidence.json',
    ),
    'x',
    { flag: 'wx' },
  );
  await writeFile(state.patchPath, retainedPatch, { flag: 'wx' });
  await writeFile(receiptPath, receiptBody, { encoding: 'utf8', flag: 'wx' });
  assert.equal(await pathExists(candidate.worktreePath), true);
  assert.equal(await pathExists(verification.worktreePath), true);

  const recovered = await retryRepairCleanup(fixture.repo, repairId);
  const lifecycleAfterRecovery = await readRepairLifecycle(state.lifecyclePath);
  const lifecycleBytesAfterRecovery = await readFile(state.lifecyclePath, 'utf8');
  const repeated = await retryRepairCleanup(fixture.repo, repairId);

  assert.equal(recovered.state, 'cleanup_completed');
  assert.equal(repeated.state, 'cleanup_completed');
  assert.equal(recovered.failure, null);
  assert.equal(repeated.failure, null);
  assert.equal(recovered.verificationReceiptPath, receiptPath);
  assert.equal(repeated.verificationReceiptPath, receiptPath);
  assert.equal(recovered.verificationReceiptSha256, sha256Bytes(receiptBody));
  assert.equal(repeated.verificationReceiptSha256, sha256Bytes(receiptBody));
  assert.deepEqual(
    lifecycleAfterRecovery.events.map((event) => event.state),
    [
      'created',
      'baseline_verified',
      'codex_completed',
      'candidate_policy_accepted',
      'awaiting_human_review',
      'human_approved',
      'verification_started',
      'verification_passed',
      'evidence_saved',
      'cleanup_completed',
    ],
  );
  assert.equal(
    lifecycleAfterRecovery.events.some(
      (event) => event.state === 'verification_failed',
    ),
    false,
  );
  assert.equal(
    await readFile(state.lifecyclePath, 'utf8'),
    lifecycleBytesAfterRecovery,
  );
  assert.equal(await readFile(receiptPath, 'utf8'), receiptBody);
  assert.equal((await readLocalRepairState(statePath)).failure, null);
  assert.equal(await pathExists(candidate.worktreePath), false);
  assert.equal(await pathExists(verification.worktreePath), false);
  const registered = (
    await runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
  ).stdout;
  assert.equal(registered.includes(candidate.worktreePath), false);
  assert.equal(registered.includes(verification.worktreePath), false);
  assert.equal(await readFile(fixture.sentinelPath, 'utf8'), 'retained sentinel\n');
});

async function retainedPassFixtureForTamperTest(): Promise<{
  readonly fixture: RepositoryFixture;
  readonly candidate: DisposableWorktree;
  readonly verification: DisposableWorktree;
  readonly state: LocalRepairStateV1;
  readonly statePath: string;
  readonly receiptPath: string;
  readonly receiptBody: string;
}> {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const candidate = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
  const verification = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'verification'),
  });
  worktrees.add(candidate);
  worktrees.add(verification);
  const initialState = stateFixture({
    fixture,
    repairId,
    state: 'verification_passed',
    candidateWorktreePath: candidate.worktreePath,
    verificationWorktreePath: verification.worktreePath,
  });
  assert.notEqual(initialState.patch, null);
  const retainedPatch = Buffer.from('bounded retained patch\n', 'utf8');
  const retainedPatchSha256 = sha256Bytes(retainedPatch);
  const receiptPath = join(
    initialState.artifactDirectory,
    'verification',
    'verification-receipt.json',
  );
  const stateWithPatch: LocalRepairStateV1 = {
    ...initialState,
    patch: {
      ...initialState.patch!,
      sha256: retainedPatchSha256,
      bytes: retainedPatch.byteLength,
    },
    verificationReceiptPath: receiptPath,
    verificationReceiptSha256: null,
  };
  const receipt: RepairVerificationReceiptV1 = {
    schemaVersion: REPAIR_VERIFICATION_RECEIPT_VERSION,
    repairId,
    verdict: 'pass',
    baseCommit: stateWithPatch.baseCommit,
    approvedPatchSha256: retainedPatchSha256,
    patchBytes: retainedPatch.byteLength,
    verificationWorktreeFresh: true,
    candidateAndVerificationWorktreesDistinct: true,
    patchAppliedByExactDigest: true,
    patchUnchangedAfterVerification: true,
    isolatedPort: 45_124,
    baseUrl: 'http://127.0.0.1:45124',
    startedAt: '2026-07-15T10:01:00.000Z',
    completedAt: '2026-07-15T10:02:00.000Z',
    commands: VERIFICATION_STAGE_IDS.map(commandReceipt),
    checks: {
      build: true,
      raceOffSingle: passingScenario('off', 'tamper-off-single'),
      raceOnSingle: passingScenario('on', 'tamper-on-single'),
      raceOffFive: Array.from({ length: 5 }, (_, index) =>
        passingScenario('off', `tamper-off-${index + 1}`),
      ),
      raceOnFive: Array.from({ length: 5 }, (_, index) =>
        passingScenario('on', `tamper-on-${index + 1}`),
      ),
      propagationExpectedRed: propagationExpectedRedScenario(),
      propagationGreenTestCount: 6,
      startupRegressionTestCount: 1,
    },
    retainedArtifacts: [
      {
        path: 'race-off-single/evidence.json',
        bytes: 1,
        sha256: sha256Bytes('x'),
      },
    ],
  };
  const receiptBody = `${JSON.stringify(receipt, null, 2)}\n`;
  const state: LocalRepairStateV1 = {
    ...stateWithPatch,
    verificationReceiptSha256: sha256Bytes(receiptBody),
  };
  const statePath = await persistStateAndLifecycle(state, [
    'created',
    'baseline_verified',
    'codex_completed',
    'candidate_policy_accepted',
    'awaiting_human_review',
    'human_approved',
    'verification_started',
    'verification_passed',
  ]);
  await mkdir(join(state.artifactDirectory, 'verification', 'race-off-single'), {
    recursive: true,
  });
  await writeFile(
    join(
      state.artifactDirectory,
      'verification',
      'race-off-single',
      'evidence.json',
    ),
    'x',
    { flag: 'wx' },
  );
  await writeFile(state.patchPath, retainedPatch, { flag: 'wx' });
  await writeFile(receiptPath, receiptBody, { encoding: 'utf8', flag: 'wx' });
  return {
    fixture,
    candidate,
    verification,
    state,
    statePath,
    receiptPath,
    receiptBody,
  };
}

test('fails closed when a shape-compatible retained PASS receipt changes after its digest is anchored', async () => {
  const retained = await retainedPassFixtureForTamperTest();
  const tampered = JSON.parse(retained.receiptBody) as Record<string, unknown>;
  tampered.completedAt = '2026-07-15T10:03:00.000Z';
  const tamperedBody = `${JSON.stringify(tampered, null, 2)}\n`;
  assert.notEqual(sha256Bytes(tamperedBody), retained.state.verificationReceiptSha256);
  await writeFile(retained.receiptPath, tamperedBody, 'utf8');

  const recovered = await retryRepairCleanup(
    retained.fixture.repo,
    retained.state.repairId,
  );
  const lifecycleAfterRecovery = await readRepairLifecycle(
    retained.state.lifecyclePath,
  );
  const lifecycleBytesAfterRecovery = await readFile(
    retained.state.lifecyclePath,
    'utf8',
  );
  const repeated = await retryRepairCleanup(
    retained.fixture.repo,
    retained.state.repairId,
  );

  assert.equal(recovered.state, 'cleanup_completed');
  assert.equal(repeated.state, 'cleanup_completed');
  assert.equal(recovered.failure?.stage, 'verification_receipt_recovery');
  assert.equal(repeated.failure?.stage, 'verification_receipt_recovery');
  assert.match(recovered.failure?.message ?? '', /receipt digest changed/u);
  assert.equal(
    recovered.verificationReceiptSha256,
    retained.state.verificationReceiptSha256,
  );
  assert.notEqual(
    await fileSha256(retained.receiptPath),
    recovered.verificationReceiptSha256,
  );
  assert.equal(
    lifecycleAfterRecovery.events.filter(
      (event) => event.state === 'verification_passed',
    ).length,
    1,
  );
  assert.deepEqual(
    lifecycleAfterRecovery.events.slice(-2).map((event) => event.state),
    ['evidence_saved', 'cleanup_completed'],
  );
  assert.equal(
    await readFile(retained.state.lifecyclePath, 'utf8'),
    lifecycleBytesAfterRecovery,
  );
  assert.equal(await pathExists(retained.candidate.worktreePath), false);
  assert.equal(await pathExists(retained.verification.worktreePath), false);
  assert.equal(
    await readFile(retained.fixture.sentinelPath, 'utf8'),
    'retained sentinel\n',
  );
});
