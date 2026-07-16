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

import { sha256CanonicalJson } from '../../src/investigation/canonical-json.js';
import {
  REPAIR_LOCAL_STATE_VERSION,
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  readRepairLifecycle,
  sha256Bytes,
  writeLocalRepairState,
  writeNewJson,
  type LocalRepairStateV1,
  type RepairStateName,
} from '../../src/repair/artifact.js';
import type { RaceRepairCandidateV1 } from '../../src/repair/contracts.js';
import {
  REPAIR_APPROVAL_VERSION,
  expectedReviewPhrase,
  humanRepairDecisionSchema,
} from '../../src/repair/approval.js';
import { validateRepairDiff } from '../../src/repair/diff-validator.js';
import {
  FOUNDATION_POLICY_VERSION,
  FROZEN_CRITICAL_PATHS,
  MILESTONE_03_COMMIT,
  MILESTONE_03_TAG,
} from '../../src/repair/foundation.js';
import {
  resolveCleanRepository,
  isVolatileCodexTurnDiffCaptureRef,
  runGit,
  type CleanRepositorySnapshot,
} from '../../src/repair/git.js';
import type { RepairProviderResult } from '../../src/repair/provider.js';
import {
  readBoundRepairState,
  retireHumanApprovedRaceRepairInteractively,
  retryRepairCleanup,
  verifyHumanApprovedRaceRepair,
} from '../../src/repair/repair-flow.js';
import {
  REPAIR_RETIREMENT_REASON,
  REPAIR_RETIREMENT_VERSION,
  expectedRetirementPhrase,
  humanRepairRetirementSchema,
  type HumanRepairRetirementV1,
} from '../../src/repair/retirement.js';
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
  expectedDefaultRepairWorktreePath,
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
let cachedValidatedCandidate:
  | Awaited<ReturnType<typeof validateRepairDiff>>
  | null = null;
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
  await mkdir(join(repo, 'src', 'client'), { recursive: true });
  await runGit(repo, ['init', '--initial-branch=main']);
  await runGit(repo, ['config', 'user.name', 'PromiseProof Recovery Tests']);
  await runGit(repo, ['config', 'user.email', 'tests@promiseproof.invalid']);
  await writeFile(join(repo, '.gitignore'), 'test-results/\n', 'utf8');
  await writeFile(join(repo, '.gitattributes'), '* text=auto eol=lf\n', 'utf8');
  await writeFile(join(repo, 'src', 'client', 'main.ts'), BASE_SOURCE, 'utf8');
  await writeFile(sentinelPath, 'retained sentinel\n', 'utf8');
  await runGit(repo, [
    'add',
    '.gitattributes',
    '.gitignore',
    'must-survive.txt',
    'src/client/main.ts',
  ]);
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
  const repositoryRoot = input.fixture.repository.repoRoot;
  const artifactDirectory = join(
    repositoryRoot,
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
    projectRoot: repositoryRoot,
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

test('binds a hand-built recovery state to the canonical repository root before cleanup', async () => {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const plan = await planDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
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

  const bound = await readBoundRepairState(fixture.repo, repairId);
  assert.equal(bound.state.projectRoot, fixture.repository.repoRoot);
  assert.equal(
    bound.state.artifactDirectory,
    join(
      fixture.repository.repoRoot,
      'test-results',
      'repair-runs',
      repairId,
    ),
  );

  const recovered = await retryRepairCleanup(fixture.repo, repairId);
  assert.equal(recovered.state, 'cleanup_completed');
  assert.equal(recovered.failure?.code, 'PP_REPAIR_PREPARATION_FAILED');
  await cleanupPlannedDisposableWorktree(plan);
});

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

interface AwaitingReviewCrashFixture {
  readonly fixture: RepositoryFixture;
  readonly candidate: DisposableWorktree;
  readonly state: LocalRepairStateV1;
  readonly statePath: string;
  readonly retainedPatch: string;
}

async function createAwaitingReviewCrashFixture(input: {
  readonly candidatePayloadMatches?: boolean;
  readonly awaitingPayloadMatches?: boolean;
} = {}): Promise<AwaitingReviewCrashFixture> {
  const fixture = await createRepositoryFixture();
  const repairId = randomUUID();
  const candidate = await createDisposableWorktree(fixture.repo, {
    allocationId: repairWorktreeAllocationId(repairId, 'candidate'),
  });
  worktrees.add(candidate);
  await writeFile(
    join(candidate.worktreePath, 'src', 'client', 'main.ts'),
    REPAIRED_SOURCE,
    'utf8',
  );
  await mkdir(join(candidate.worktreePath, 'tests', 'regression'), {
    recursive: true,
  });
  await writeFile(
    join(
      candidate.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    ),
    REGRESSION_TEST,
    'utf8',
  );
  const validated =
    cachedValidatedCandidate ?? (await validateRepairDiff(candidate));
  cachedValidatedCandidate ??= validated;
  const patch: NonNullable<LocalRepairStateV1['patch']> = {
    sha256: validated.patchSha256,
    bytes: validated.patchBytes,
    additions: validated.addedLines,
    deletions: validated.deletedLines,
    changedFiles: [
      {
        path: 'src/client/main.ts',
        status: 'modified',
        beforeSha256: sha256Bytes(BASE_SOURCE),
        afterSha256: await fileSha256(
          join(candidate.worktreePath, 'src', 'client', 'main.ts'),
        ),
      },
      {
        path: 'tests/regression/initialization-order.spec.ts',
        status: 'added',
        beforeSha256: null,
        afterSha256: await fileSha256(
          join(
            candidate.worktreePath,
            'tests',
            'regression',
            'initialization-order.spec.ts',
          ),
        ),
      },
    ],
  };
  const state = stateFixture({
    fixture,
    repairId,
    state: 'candidate_policy_accepted',
    candidateWorktreePath: candidate.worktreePath,
    patch,
    approvalSha256: null,
  });
  await mkdir(state.artifactDirectory, { recursive: true });
  await writeFile(state.patchPath, validated.patch, { encoding: 'utf8', flag: 'wx' });
  for (const lifecycleState of [
    'created',
    'baseline_verified',
    'codex_completed',
  ] as const) {
    await appendRepairLifecycle(
      state.lifecyclePath,
      repairId,
      lifecycleState,
      { crashFixture: true, lifecycleState },
    );
  }
  await appendRepairLifecycle(
    state.lifecyclePath,
    repairId,
    'candidate_policy_accepted',
    input.candidatePayloadMatches === false
      ? { ...patch, bytes: patch.bytes + 1 }
      : patch,
  );
  await appendRepairLifecycle(
    state.lifecyclePath,
    repairId,
    'awaiting_human_review',
    {
      patchSha256: patch.sha256,
      patchBytes:
        input.awaitingPayloadMatches === false ? patch.bytes + 1 : patch.bytes,
      automaticApproval: false,
    },
  );
  const statePath = join(state.artifactDirectory, 'state.json');
  await writeLocalRepairState(statePath, state);
  return {
    fixture,
    candidate,
    state,
    statePath,
    retainedPatch: validated.patch,
  };
}

async function approveAwaitingReviewFixture(
  crash: AwaitingReviewCrashFixture,
): Promise<LocalRepairStateV1> {
  const reconciled = await retryRepairCleanup(
    crash.fixture.repo,
    crash.state.repairId,
  );
  assert.equal(reconciled.state, 'awaiting_human_review');
  assert.notEqual(reconciled.patch, null);
  const patch = reconciled.patch!;
  const phrase = expectedReviewPhrase(
    'APPROVE',
    reconciled.repairId,
    patch.sha256,
  );
  const decision = humanRepairDecisionSchema.parse({
    schemaVersion: REPAIR_APPROVAL_VERSION,
    repairId: reconciled.repairId,
    decision: 'approved',
    patchSha256: patch.sha256,
    patchBytes: patch.bytes,
    decidedAt: '2026-07-15T20:00:00.000Z',
    reviewer: 'human_operator',
    method: 'interactive_tty_exact_phrase',
    confirmationSha256: sha256Bytes(phrase),
  });
  await writeNewJson(reconciled.approvalPath, decision);
  await appendRepairLifecycle(
    reconciled.lifecyclePath,
    reconciled.repairId,
    'human_approved',
    decision,
  );
  const approved = structuredClone(reconciled);
  approved.state = 'human_approved';
  approved.approvalSha256 = await fileSha256(approved.approvalPath);
  approved.updatedAt = '2026-07-15T20:00:00.001Z';
  await writeLocalRepairState(crash.statePath, approved);
  return approved;
}

async function retirementDecisionFixture(
  repositoryPath: string,
  approved: LocalRepairStateV1,
  decidedAt: string,
): Promise<HumanRepairRetirementV1> {
  assert.notEqual(approved.patch, null);
  assert.notEqual(approved.approvalSha256, null);
  const current = await resolveCleanRepository(repositoryPath);
  const currentTree = (
    await runGit(repositoryPath, [
      'rev-parse',
      '--verify',
      `${current.baseHead}^{tree}`,
    ])
  ).stdout.trim();
  const integrityState = (state: CleanRepositorySnapshot['refState']) => ({
    refs: state.refs.filter(
      (entry) => !isVolatileCodexTurnDiffCaptureRef(entry.name),
    ),
  });
  const retainedIntegrityState = integrityState(approved.baseRefState);
  const observedIntegrityState = integrityState(current.refState);
  const retainedRefs = new Map(
    retainedIntegrityState.refs.map((entry) => [entry.name, entry]),
  );
  const observedRefs = new Map(
    observedIntegrityState.refs.map((entry) => [entry.name, entry]),
  );
  const securityRelevantRefsAdded = [...observedRefs.keys()].filter(
    (name) => !retainedRefs.has(name),
  ).length;
  const securityRelevantRefsRemoved = [...retainedRefs.keys()].filter(
    (name) => !observedRefs.has(name),
  ).length;
  const securityRelevantRefsChanged = [...retainedRefs.entries()].filter(
    ([name, retained]) => {
      const observed = observedRefs.get(name);
      return (
        observed !== undefined &&
        (observed.objectId !== retained.objectId ||
          observed.symbolicTarget !== retained.symbolicTarget)
      );
    },
  ).length;
  const retirementPhrase = expectedRetirementPhrase(
    approved.repairId,
    approved.patch!.sha256,
  );
  return humanRepairRetirementSchema.parse({
    schemaVersion: REPAIR_RETIREMENT_VERSION,
    repairId: approved.repairId,
    disposition: 'retired_without_verification',
    verificationVerdict: 'not_run',
    verificationStarted: false,
    playwrightInvoked: false,
    verificationWorktreeRetainedAtDecision: false,
    verificationReceiptCreated: false,
    patchSha256: approved.patch!.sha256,
    patchBytes: approved.patch!.bytes,
    approvalSha256: approved.approvalSha256,
    retainedBaseCommit: approved.baseCommit,
    retainedBaseTree: approved.baseTree,
    retainedHeadRef: approved.baseHeadRef,
    observedCurrentCommit: current.baseHead,
    observedCurrentTree: currentTree,
    observedCurrentHeadRef: current.headRef,
    retainedFullRefStateSha256: sha256CanonicalJson(approved.baseRefState),
    retainedIntegrityRefStateSha256: sha256CanonicalJson(
      retainedIntegrityState,
    ),
    observedIntegrityRefStateSha256: sha256CanonicalJson(
      observedIntegrityState,
    ),
    integrityRefPolicy:
      'exclude_exact_codex_turn_diff_capture_base_refs_v1',
    drift: {
      headChanged: current.baseHead !== approved.baseCommit,
      headRefChanged: current.headRef !== approved.baseHeadRef,
      integrityRefsChanged:
        sha256CanonicalJson(retainedIntegrityState) !==
        sha256CanonicalJson(observedIntegrityState),
      securityRelevantRefsAdded,
      securityRelevantRefsRemoved,
      securityRelevantRefsChanged,
    },
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
    decidedAt,
    reviewer: 'human_operator',
    method: 'interactive_tty_exact_phrase',
    confirmationSha256: sha256Bytes(retirementPhrase),
  });
}

test('retires an old-base approved candidate only through retained NOT RUN evidence and cleanup', async () => {
  const crash = await createAwaitingReviewCrashFixture();
  const approved = await approveAwaitingReviewFixture(crash);
  const lifecycleBeforeDrift = await readFile(approved.lifecyclePath, 'utf8');
  const volatileCaptureRef =
    'refs/codex/turn-diffs/captures/1784150000000/d0321504-ca0c-4dba-8735-d08a0ea8791d/base';
  await runGit(crash.fixture.repo, [
    'update-ref',
    volatileCaptureRef,
    approved.baseCommit,
  ]);

  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_NOT_REQUIRED/u,
  );
  assert.equal(await readFile(approved.lifecyclePath, 'utf8'), lifecycleBeforeDrift);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await runGit(crash.fixture.repo, ['update-ref', '-d', volatileCaptureRef]);

  const originalBranch = approved.baseHeadRef?.replace(/^refs\/heads\//u, '');
  assert.notEqual(originalBranch, undefined);
  await runGit(crash.fixture.repo, [
    'switch',
    '--quiet',
    '-c',
    'unsafe-retirement-drift',
  ]);
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_DRIFT_UNSAFE/u,
  );
  assert.equal(await readFile(approved.lifecyclePath, 'utf8'), lifecycleBeforeDrift);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await runGit(crash.fixture.repo, ['switch', '--quiet', originalBranch!]);
  await runGit(crash.fixture.repo, [
    'branch',
    '--delete',
    'unsafe-retirement-drift',
  ]);
  const unrelatedCommit = (
    await runGit(crash.fixture.repo, [
      'commit-tree',
      approved.baseTree,
      '-m',
      'test: unrelated retirement base',
    ])
  ).stdout.trim();
  await runGit(crash.fixture.repo, [
    'update-ref',
    approved.baseHeadRef!,
    unrelatedCommit,
    approved.baseCommit,
  ]);
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_DRIFT_UNSAFE/u,
  );
  assert.equal(await readFile(approved.lifecyclePath, 'utf8'), lifecycleBeforeDrift);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await runGit(crash.fixture.repo, [
    'update-ref',
    approved.baseHeadRef!,
    approved.baseCommit,
    unrelatedCommit,
  ]);

  await writeFile(
    join(crash.fixture.repo, 'orchestrator-policy.txt'),
    'exact volatile ref boundary\n',
    'utf8',
  );
  await runGit(crash.fixture.repo, ['add', 'orchestrator-policy.txt']);
  await runGit(crash.fixture.repo, [
    'commit',
    '-m',
    'test: advance orchestrator policy',
  ]);
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_TTY_REQUIRED/u,
  );
  assert.equal(await readFile(approved.lifecyclePath, 'utf8'), lifecycleBeforeDrift);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);

  const retirement = await retirementDecisionFixture(
    crash.fixture.repo,
    approved,
    '2026-07-15T20:01:00.000Z',
  );
  const retirementPath = join(
    approved.artifactDirectory,
    'retirement-decision.json',
  );
  const forgedRetirement = humanRepairRetirementSchema.parse({
    ...retirement,
    drift: {
      ...retirement.drift,
      securityRelevantRefsChanged:
        retirement.drift.securityRelevantRefsChanged + 1,
    },
  });
  await writeNewJson(retirementPath, forgedRetirement);
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_CONTEXT_CHANGED/u,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await rm(retirementPath);
  await writeNewJson(retirementPath, retirement);
  const lifecycleWithPendingDecision = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  await assert.rejects(
    verifyHumanApprovedRaceRepair({
      projectRoot: crash.fixture.repo,
      repairId: approved.repairId,
    }),
    /PP_REPAIR_RETIREMENT_PENDING/u,
  );
  assert.equal(
    await readFile(approved.lifecyclePath, 'utf8'),
    lifecycleWithPendingDecision,
  );
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_TTY_REQUIRED/u,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), true);

  const retirementDecisionSha256 = await fileSha256(retirementPath);
  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'retired_without_verification',
    {
      decision: retirement,
      retirementDecisionSha256,
    },
  );
  const lifecycleAfterRetirementEvent = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  const unexpectedVerificationPath = join(
    tmpdir(),
    'promiseproof-repair-worktrees',
    `repair-${repairWorktreeAllocationId(approved.repairId, 'verification')}`,
    'checkout',
  );
  const retirementEntryPoints = [
    () =>
      retireHumanApprovedRaceRepairInteractively(
        crash.fixture.repo,
        approved.repairId,
      ),
    () => retryRepairCleanup(crash.fixture.repo, approved.repairId),
  ] as const;
  const contradictoryStates: LocalRepairStateV1[] = [
    {
      ...approved,
      verificationWorktreePath: unexpectedVerificationPath,
    },
    ...(['verification_started', 'verification_passed', 'verification_failed'] as const).map(
      (state) => ({ ...approved, state }),
    ),
  ];
  for (const contradictoryState of contradictoryStates) {
    await writeLocalRepairState(crash.statePath, contradictoryState);
    const retainedStateBytes = await readFile(crash.statePath, 'utf8');
    for (const invoke of retirementEntryPoints) {
      await assert.rejects(
        invoke(),
        /PP_REPAIR_RETIREMENT_VERIFICATION_PRESENT/u,
      );
      assert.equal(await readFile(crash.statePath, 'utf8'), retainedStateBytes);
      assert.equal(
        await readFile(approved.lifecyclePath, 'utf8'),
        lifecycleAfterRetirementEvent,
      );
      assert.equal(await pathExists(crash.candidate.worktreePath), true);
    }
  }
  const impossibleAheadState: LocalRepairStateV1 = {
    ...approved,
    state: 'cleanup_completed',
  };
  await writeLocalRepairState(crash.statePath, impossibleAheadState);
  const impossibleAheadStateBytes = await readFile(crash.statePath, 'utf8');
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_EVIDENCE_INVALID/u,
    );
    assert.equal(
      await readFile(crash.statePath, 'utf8'),
      impossibleAheadStateBytes,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleAfterRetirementEvent,
    );
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
  }
  await writeLocalRepairState(crash.statePath, approved);

  const unexpectedVerificationDirectory = join(
    approved.artifactDirectory,
    'verification',
  );
  const unexpectedVerificationSentinel = join(
    unexpectedVerificationDirectory,
    'unexpected-sentinel.txt',
  );
  await mkdir(unexpectedVerificationDirectory, { recursive: true });
  await writeFile(
    unexpectedVerificationSentinel,
    'verification must remain not run\n',
    'utf8',
  );
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_VERIFICATION_PRESENT/u,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleAfterRetirementEvent,
    );
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
    assert.equal(
      await readFile(unexpectedVerificationSentinel, 'utf8'),
      'verification must remain not run\n',
    );
  }
  await rm(unexpectedVerificationDirectory, { recursive: true });

  const unexpectedVerificationWorktree = await createDisposableWorktree(
    crash.fixture.repo,
    {
      allocationId: repairWorktreeAllocationId(
        approved.repairId,
        'verification',
      ),
    },
  );
  worktrees.add(unexpectedVerificationWorktree);
  const alternateCandidateRoot = join(
    tmpdir(),
    'alternate-repair-parent',
    `repair-${repairWorktreeAllocationId(approved.repairId, 'candidate')}`,
  );
  const parentTamperedState: LocalRepairStateV1 = {
    ...approved,
    candidateWorktreePath: join(alternateCandidateRoot, 'checkout'),
    codexHomePath: join(alternateCandidateRoot, 'codex-home'),
    toolTempPath: join(alternateCandidateRoot, 'tool-temp'),
  };
  await writeLocalRepairState(crash.statePath, parentTamperedState);
  const parentTamperedStateBytes = await readFile(crash.statePath, 'utf8');
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(invoke(), /PP_REPAIR_STATE_BINDING_INVALID/u);
    assert.equal(
      await readFile(crash.statePath, 'utf8'),
      parentTamperedStateBytes,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleAfterRetirementEvent,
    );
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
    assert.equal(
      await pathExists(unexpectedVerificationWorktree.worktreePath),
      true,
    );
  }
  await writeLocalRepairState(crash.statePath, approved);
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_VERIFICATION_PRESENT/u,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleAfterRetirementEvent,
    );
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
    assert.equal(
      await pathExists(unexpectedVerificationWorktree.worktreePath),
      true,
    );
  }
  await cleanupDisposableWorktree(unexpectedVerificationWorktree);
  worktrees.delete(unexpectedVerificationWorktree);

  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'evidence_saved',
    { tamperedRetirementEvidence: true },
  );
  await assert.rejects(
    retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    ),
    /PP_REPAIR_RETIREMENT_EVIDENCE_INVALID/u,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await writeFile(
    approved.lifecyclePath,
    lifecycleAfterRetirementEvent,
    'utf8',
  );
  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'evidence_saved',
    {
      disposition: retirement.disposition,
      verificationVerdict: retirement.verificationVerdict,
      verificationStarted: retirement.verificationStarted,
      playwrightInvoked: retirement.playwrightInvoked,
      retirementDecisionSha256,
      patchSha256: retirement.patchSha256,
      approvalSha256: retirement.approvalSha256,
      nextAction: retirement.nextAction,
    },
  );
  const lifecycleBeforeRetiredVerify = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  await assert.rejects(
    verifyHumanApprovedRaceRepair({
      projectRoot: crash.fixture.repo,
      repairId: approved.repairId,
    }),
    /PP_REPAIR_RETIRED_UNVERIFIED/u,
  );
  assert.equal(
    await readFile(approved.lifecyclePath, 'utf8'),
    lifecycleBeforeRetiredVerify,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), true);

  const retired = await retireHumanApprovedRaceRepairInteractively(
    crash.fixture.repo,
    approved.repairId,
  );
  await assert.rejects(
    verifyHumanApprovedRaceRepair({
      projectRoot: crash.fixture.repo,
      repairId: approved.repairId,
    }),
    /PP_REPAIR_RETIRED_UNVERIFIED/u,
  );
  const postCleanupVerificationDirectory = join(
    approved.artifactDirectory,
    'verification',
  );
  const postCleanupVerificationSentinel = join(
    postCleanupVerificationDirectory,
    'post-cleanup-sentinel.txt',
  );
  await mkdir(postCleanupVerificationDirectory, { recursive: true });
  await writeFile(
    postCleanupVerificationSentinel,
    'late verification evidence is forbidden\n',
    'utf8',
  );
  const lifecycleBeforeLateArtifact = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  const stateBeforeLateArtifact = await readFile(crash.statePath, 'utf8');
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_VERIFICATION_PRESENT/u,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleBeforeLateArtifact,
    );
    assert.equal(await readFile(crash.statePath, 'utf8'), stateBeforeLateArtifact);
    assert.equal(
      await readFile(postCleanupVerificationSentinel, 'utf8'),
      'late verification evidence is forbidden\n',
    );
  }
  await rm(postCleanupVerificationDirectory, { recursive: true });

  const lateCandidateWorktree = await createDisposableWorktree(
    crash.fixture.repo,
    {
      allocationId: repairWorktreeAllocationId(
        approved.repairId,
        'candidate',
      ),
    },
  );
  worktrees.add(lateCandidateWorktree);
  const lifecycleBeforeLateCandidate = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  const stateBeforeLateCandidate = await readFile(crash.statePath, 'utf8');
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_CANDIDATE_PRESENT/u,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleBeforeLateCandidate,
    );
    assert.equal(await readFile(crash.statePath, 'utf8'), stateBeforeLateCandidate);
    assert.equal(await pathExists(lateCandidateWorktree.worktreePath), true);
  }
  await cleanupDisposableWorktree(lateCandidateWorktree);
  worktrees.delete(lateCandidateWorktree);

  const completedState = await readLocalRepairState(crash.statePath);
  const injectedCleanupFailure: LocalRepairStateV1 = {
    ...completedState,
    failure: {
      stage: 'cleanup',
      code: 'PP_FORGED_CLEANUP_FAILURE',
      message: 'a cleanup failure without a lifecycle event is invalid',
      recordedAt: '2026-07-15T20:02:00.000Z',
    },
  };
  await writeLocalRepairState(crash.statePath, injectedCleanupFailure);
  const injectedCleanupFailureBytes = await readFile(crash.statePath, 'utf8');
  for (const invoke of retirementEntryPoints) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_EVIDENCE_INVALID/u,
    );
    assert.equal(
      await readFile(crash.statePath, 'utf8'),
      injectedCleanupFailureBytes,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleBeforeLateCandidate,
    );
  }
  await writeLocalRepairState(crash.statePath, completedState);
  const repeated = await retireHumanApprovedRaceRepairInteractively(
    crash.fixture.repo,
    approved.repairId,
  );
  const lifecycle = await readRepairLifecycle(approved.lifecyclePath);
  assert.equal(retired.decision.verificationVerdict, 'not_run');
  assert.equal(retired.cleanupState, 'cleanup_completed');
  assert.equal(repeated.cleanupState, 'cleanup_completed');
  assert.deepEqual(
    lifecycle.events.slice(-3).map((event) => event.state),
    [
      'retired_without_verification',
      'evidence_saved',
      'cleanup_completed',
    ],
  );
  assert.equal(
    lifecycle.events.some((event) => event.state === 'verification_started'),
    false,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), false);
  assert.equal(await pathExists(approved.patchPath), true);
  assert.equal(await pathExists(approved.approvalPath), true);
  assert.equal(await pathExists(retirementPath), true);
  assert.equal(
    await pathExists(join(approved.artifactDirectory, 'verification')),
    false,
  );
  assert.equal(
    (await readLocalRepairState(crash.statePath)).state,
    'cleanup_completed',
  );
  assert.equal(
    await readFile(crash.fixture.sentinelPath, 'utf8'),
    'retained sentinel\n',
  );
});

test('binds a retained retirement cleanup failure to its lifecycle payload before retrying cleanup', async () => {
  const crash = await createAwaitingReviewCrashFixture();
  const approved = await approveAwaitingReviewFixture(crash);
  await writeFile(
    join(crash.fixture.repo, 'cleanup-recovery-policy.txt'),
    'retain exact cleanup failure evidence\n',
    'utf8',
  );
  await runGit(crash.fixture.repo, ['add', 'cleanup-recovery-policy.txt']);
  await runGit(crash.fixture.repo, [
    'commit',
    '-m',
    'test: advance cleanup recovery policy',
  ]);
  const retirement = await retirementDecisionFixture(
    crash.fixture.repo,
    approved,
    '2026-07-15T20:03:00.000Z',
  );
  const retirementPath = join(
    approved.artifactDirectory,
    'retirement-decision.json',
  );
  await writeNewJson(retirementPath, retirement);
  const retirementDecisionSha256 = await fileSha256(retirementPath);
  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'retired_without_verification',
    {
      decision: retirement,
      retirementDecisionSha256,
    },
  );
  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'evidence_saved',
    {
      disposition: retirement.disposition,
      verificationVerdict: retirement.verificationVerdict,
      verificationStarted: retirement.verificationStarted,
      playwrightInvoked: retirement.playwrightInvoked,
      retirementDecisionSha256,
      patchSha256: retirement.patchSha256,
      approvalSha256: retirement.approvalSha256,
      nextAction: retirement.nextAction,
    },
  );
  const cleanupFailure = {
    stage: 'cleanup',
    code: 'PP_REPAIR_TEST_CLEANUP_INTERRUPTED',
    message: 'simulated retained cleanup failure',
    recordedAt: '2026-07-15T20:03:01.000Z',
  } as const;
  await appendRepairLifecycle(
    approved.lifecyclePath,
    approved.repairId,
    'cleanup_failed',
    cleanupFailure,
  );
  const lifecycleFirstCleanupFailureState: LocalRepairStateV1 = {
    ...approved,
    state: 'evidence_saved',
    failure: {
      stage: 'verification_precondition',
      code: REPAIR_RETIREMENT_REASON,
      message:
        'Human-approved candidate retired after the source integrity base changed; verification never started, no verification worktree was retained at the decision, and Playwright was not invoked.',
      recordedAt: retirement.decidedAt,
    },
  };
  await writeLocalRepairState(
    crash.statePath,
    lifecycleFirstCleanupFailureState,
  );
  const lifecycleFirstStateBytes = await readFile(crash.statePath, 'utf8');
  const lifecycleAfterCleanupFailure = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  for (const invoke of [
    () =>
      retireHumanApprovedRaceRepairInteractively(
        crash.fixture.repo,
        approved.repairId,
      ),
    () => retryRepairCleanup(crash.fixture.repo, approved.repairId),
  ]) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_EVIDENCE_INVALID/u,
    );
    assert.equal(await readFile(crash.statePath, 'utf8'), lifecycleFirstStateBytes);
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleAfterCleanupFailure,
    );
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
  }
  const validCleanupFailureState: LocalRepairStateV1 = {
    ...approved,
    state: 'cleanup_failed',
    failure: cleanupFailure,
  };
  const tamperedCleanupFailureState: LocalRepairStateV1 = {
    ...validCleanupFailureState,
    failure: {
      ...cleanupFailure,
      message: 'edited cleanup failure must not survive reconciliation',
    },
  };
  await writeLocalRepairState(crash.statePath, tamperedCleanupFailureState);
  const lifecycleBeforeTamperChecks = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  const tamperedStateBytes = await readFile(crash.statePath, 'utf8');
  for (const invoke of [
    () =>
      retireHumanApprovedRaceRepairInteractively(
        crash.fixture.repo,
        approved.repairId,
      ),
    () => retryRepairCleanup(crash.fixture.repo, approved.repairId),
  ]) {
    await assert.rejects(
      invoke(),
      /PP_REPAIR_RETIREMENT_EVIDENCE_INVALID/u,
    );
    assert.equal(
      await readFile(approved.lifecyclePath, 'utf8'),
      lifecycleBeforeTamperChecks,
    );
    assert.equal(await readFile(crash.statePath, 'utf8'), tamperedStateBytes);
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
  }

  await writeLocalRepairState(crash.statePath, validCleanupFailureState);
  await runGit(crash.candidate.worktreePath, [
    'update-ref',
    'HEAD',
    retirement.observedCurrentCommit,
    approved.baseCommit,
  ]);
  const lifecycleBeforeRepeatedCleanupFailures = await readFile(
    approved.lifecyclePath,
    'utf8',
  );
  const firstRepeatedFailure =
    await retireHumanApprovedRaceRepairInteractively(
      crash.fixture.repo,
      approved.repairId,
    );
  const secondRepeatedFailure = await retryRepairCleanup(
    crash.fixture.repo,
    approved.repairId,
  );
  assert.equal(firstRepeatedFailure.cleanupState, 'cleanup_failed');
  assert.equal(secondRepeatedFailure.state, 'cleanup_failed');
  assert.deepEqual(secondRepeatedFailure.failure, cleanupFailure);
  assert.equal(
    await readFile(approved.lifecyclePath, 'utf8'),
    lifecycleBeforeRepeatedCleanupFailures,
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  await runGit(crash.candidate.worktreePath, [
    'update-ref',
    'HEAD',
    approved.baseCommit,
    retirement.observedCurrentCommit,
  ]);
  const recovered = await retireHumanApprovedRaceRepairInteractively(
    crash.fixture.repo,
    approved.repairId,
  );
  const repeated = await retryRepairCleanup(
    crash.fixture.repo,
    approved.repairId,
  );
  const lifecycle = await readRepairLifecycle(approved.lifecyclePath);
  assert.equal(recovered.cleanupState, 'cleanup_completed');
  assert.equal(repeated.state, 'cleanup_completed');
  assert.deepEqual(repeated.failure, cleanupFailure);
  assert.deepEqual(
    lifecycle.events.slice(-2).map((event) => event.state),
    ['cleanup_failed', 'cleanup_completed'],
  );
  assert.equal(await pathExists(crash.candidate.worktreePath), false);
  assert.equal(
    await readFile(crash.fixture.sentinelPath, 'utf8'),
    'retained sentinel\n',
  );
});

test('reconciles the lifecycle-first awaiting-review crash without changing evidence or cleaning the candidate', async () => {
  const crash = await createAwaitingReviewCrashFixture();
  const lifecycleBefore = await readFile(crash.state.lifecyclePath, 'utf8');
  const patchBefore = await readFile(crash.state.patchPath, 'utf8');

  const reconciled = await retryRepairCleanup(
    crash.fixture.repo,
    crash.state.repairId,
  );

  assert.equal(reconciled.state, 'awaiting_human_review');
  assert.equal((await readLocalRepairState(crash.statePath)).state, 'awaiting_human_review');
  assert.equal(await readFile(crash.state.lifecyclePath, 'utf8'), lifecycleBefore);
  assert.equal(await readFile(crash.state.patchPath, 'utf8'), patchBefore);
  assert.equal(patchBefore, crash.retainedPatch);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
  assert.equal(
    (await runGit(crash.fixture.repo, ['worktree', 'list', '--porcelain'])).stdout
      .replaceAll('\\', '/')
      .includes(crash.candidate.worktreePath.replaceAll('\\', '/')),
    true,
  );

  await assert.rejects(
    retryRepairCleanup(crash.fixture.repo, crash.state.repairId),
    /PP_REPAIR_CLEANUP_STATE_INVALID/u,
  );
  assert.equal(await readFile(crash.state.lifecyclePath, 'utf8'), lifecycleBefore);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
});

test('fails closed when generic cleanup lost the lifecycle-first failure payload', async () => {
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
    state: 'evidence_saved',
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
    'verification_failed',
    'evidence_saved',
  ]);
  const cleanupFailure = {
    stage: 'cleanup',
    code: 'PP_REPAIR_TEST_GENERIC_CLEANUP_FAILURE',
    message: 'failure payload was anchored before local state persisted',
    recordedAt: '2026-07-16T09:00:00.000Z',
  } as const;
  await appendRepairLifecycle(
    state.lifecyclePath,
    repairId,
    'cleanup_failed',
    cleanupFailure,
  );
  const lifecycleBefore = await readFile(state.lifecyclePath, 'utf8');
  const stateBefore = await readFile(statePath, 'utf8');
  await assert.rejects(
    retryRepairCleanup(fixture.repo, repairId),
    /PP_REPAIR_CLEANUP_FAILURE_EVIDENCE_MISSING/u,
  );
  assert.equal(await readFile(state.lifecyclePath, 'utf8'), lifecycleBefore);
  assert.equal(await readFile(statePath, 'utf8'), stateBefore);
  assert.equal(await pathExists(candidate.worktreePath), true);
  assert.equal(await pathExists(verification.worktreePath), true);
});

test('does not reconcile when the lifecycle has advanced beyond awaiting review', async () => {
  const crash = await createAwaitingReviewCrashFixture();
  await appendRepairLifecycle(
    crash.state.lifecyclePath,
    crash.state.repairId,
    'human_approved',
    { impossibleCrashFixtureDecision: true },
  );
  const lifecycleBefore = await readFile(crash.state.lifecyclePath, 'utf8');

  await assert.rejects(
    retryRepairCleanup(crash.fixture.repo, crash.state.repairId),
    /PP_REPAIR_CLEANUP_STATE_INVALID/u,
  );

  assert.equal(
    (await readLocalRepairState(crash.statePath)).state,
    'candidate_policy_accepted',
  );
  assert.equal(await readFile(crash.state.lifecyclePath, 'utf8'), lifecycleBefore);
  assert.equal(await pathExists(crash.candidate.worktreePath), true);
});

for (const mismatch of ['candidate_payload', 'awaiting_payload'] as const) {
  test(`refuses awaiting-review reconciliation when the ${mismatch.replaceAll('_', ' ')} digest differs`, async () => {
    const crash = await createAwaitingReviewCrashFixture({
      candidatePayloadMatches: mismatch !== 'candidate_payload',
      awaitingPayloadMatches: mismatch !== 'awaiting_payload',
    });
    const lifecycleBefore = await readFile(crash.state.lifecyclePath, 'utf8');

    await assert.rejects(
      retryRepairCleanup(crash.fixture.repo, crash.state.repairId),
      /PP_REPAIR_REVIEW_RECONCILIATION_INVALID/u,
    );

    assert.equal(
      (await readLocalRepairState(crash.statePath)).state,
      'candidate_policy_accepted',
    );
    assert.equal(await readFile(crash.state.lifecyclePath, 'utf8'), lifecycleBefore);
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
  });
}

for (const tamper of [
  'patch_changed',
  'patch_missing',
  'decision_present',
  'runtime_present',
  'candidate_changed',
  'candidate_base_changed',
  'shared_ref_changed',
  'head_ref_changed',
] as const) {
  test(`refuses awaiting-review reconciliation when ${tamper.replaceAll('_', ' ')}`, async () => {
    const crash = await createAwaitingReviewCrashFixture();
    const lifecycleBefore = await readFile(crash.state.lifecyclePath, 'utf8');
    if (tamper === 'patch_changed') {
      await writeFile(crash.state.patchPath, `${crash.retainedPatch}\n# changed\n`, 'utf8');
    } else if (tamper === 'patch_missing') {
      await rm(crash.state.patchPath);
    } else if (tamper === 'decision_present') {
      await writeFile(crash.state.approvalPath, '{}\n', { encoding: 'utf8', flag: 'wx' });
    } else if (tamper === 'runtime_present') {
      await mkdir(crash.state.codexHomePath);
    } else if (tamper === 'candidate_changed') {
      await writeFile(
        join(crash.candidate.worktreePath, 'src', 'client', 'main.ts'),
        `${REPAIRED_SOURCE}\n// changed after validation\n`,
        'utf8',
      );
    } else if (tamper === 'candidate_base_changed') {
      await runGit(crash.candidate.worktreePath, [
        'add',
        'src/client/main.ts',
        'tests/regression/initialization-order.spec.ts',
      ]);
      await runGit(crash.candidate.worktreePath, [
        '-c',
        'user.name=PromiseProof Recovery Tests',
        '-c',
        'user.email=tests@promiseproof.invalid',
        'commit',
        '-m',
        'test: move candidate base',
      ]);
    } else if (tamper === 'shared_ref_changed') {
      await runGit(crash.fixture.repo, [
        'branch',
        'unexpected-shared-ref',
        crash.state.baseCommit,
      ]);
    } else {
      await runGit(crash.fixture.repo, [
        'switch',
        '-c',
        'alternate-main-same-commit',
        crash.state.baseCommit,
      ]);
    }

    await assert.rejects(
      retryRepairCleanup(crash.fixture.repo, crash.state.repairId),
      /PP_REPAIR_REVIEW_RECONCILIATION_INVALID/u,
    );

    assert.equal(
      (await readLocalRepairState(crash.statePath)).state,
      'candidate_policy_accepted',
    );
    assert.equal(await readFile(crash.state.lifecyclePath, 'utf8'), lifecycleBefore);
    assert.equal(await pathExists(crash.candidate.worktreePath), true);
  });
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
    fixture.repository.repoRoot,
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
  const absentCandidate = await expectedDefaultRepairWorktreePath(
    repairId,
    'candidate',
  );
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
