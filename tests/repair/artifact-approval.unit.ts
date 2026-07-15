import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
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
  REPAIR_APPROVAL_VERSION,
  expectedReviewPhrase,
  humanRepairDecisionSchema,
  parseReviewPhrase,
  readHumanDecision,
} from '../../src/repair/approval.js';
import {
  REPAIR_LIFECYCLE_VERSION,
  REPAIR_LOCAL_STATE_VERSION,
  appendRepairLifecycle,
  canonicalStateSha256,
  readLocalRepairState,
  sha256Bytes,
  validateRepairLifecycle,
  writeLocalRepairState,
  writeNewJson,
  type LocalRepairStateV1,
} from '../../src/repair/artifact.js';
import type { RaceRepairCandidateV1 } from '../../src/repair/contracts.js';
import {
  FOUNDATION_POLICY_VERSION,
  FROZEN_CRITICAL_PATHS,
  MILESTONE_03_COMMIT,
  MILESTONE_03_TAG,
} from '../../src/repair/foundation.js';

const roots = new Set<string>();

afterEach(async () => {
  for (const root of [...roots]) {
    await rm(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-artifact-unit-'));
  roots.add(root);
  return root;
}

function eligibilityFixture(): RaceRepairCandidateV1 {
  const digest = '1'.repeat(64);
  return {
    schemaVersion: 'promiseproof.race-repair-candidate.v1',
    candidateKind: 'startup_order_repair',
    promiseAuthority: 'deterministic_typescript_and_playwright_only',
    source: {
      receiptSchemaVersion: 'promiseproof.live-stability-receipt.v1',
      canonicalReceiptSha256: digest,
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

function stateFixture(root: string, repairId = randomUUID()): LocalRepairStateV1 {
  const createdAt = '2026-07-15T10:00:00.000Z';
  const artifacts = join(root, 'test-results', 'repair-runs', repairId);
  const candidateTempRoot = join(root, 'candidate-temp');
  return {
    schemaVersion: REPAIR_LOCAL_STATE_VERSION,
    repairId,
    state: 'created',
    createdAt,
    updatedAt: createdAt,
    projectRoot: root,
    artifactDirectory: artifacts,
    lifecyclePath: join(artifacts, 'lifecycle.json'),
    patchPath: join(artifacts, 'candidate.patch'),
    approvalPath: join(artifacts, 'human-decision.json'),
    candidateWorktreePath: join(candidateTempRoot, 'checkout'),
    verificationWorktreePath: null,
    codexHomePath: join(candidateTempRoot, 'codex-home'),
    toolTempPath: join(candidateTempRoot, 'tool-temp'),
    baseCommit: '7'.repeat(40),
    baseTree: '8'.repeat(40),
    baseHeadRef: 'refs/heads/main',
    baseRefState: { refs: [] },
    milestoneTag: 'milestone-03-gpt56-investigation',
    frozenFoundation: {
      policyVersion: FOUNDATION_POLICY_VERSION,
      checkpointTag: MILESTONE_03_TAG,
      checkpointCommit: MILESTONE_03_COMMIT,
      baseCommit: '7'.repeat(40),
      baseTree: '8'.repeat(40),
      changedPathsFromCheckpoint: ['src/repair/artifact.ts'],
      allOtherCheckpointPathsUnchanged: true,
      criticalFiles: FROZEN_CRITICAL_PATHS.map((path) => ({
        path,
        checkpointBlobId: 'a'.repeat(40),
        baseBlobId: 'a'.repeat(40),
        sha256: 'b'.repeat(64),
      })),
    },
    eligibility: eligibilityFixture(),
    promptEnvelopeSha256: '9'.repeat(64),
    provider: null,
    providerFailure: null,
    failure: null,
    patch: null,
    approvalSha256: null,
    verificationReceiptPath: null,
    verificationReceiptSha256: null,
  };
}

test('appends a hash-chained lifecycle in sequence and validates the chain', async () => {
  const root = await temporaryRoot();
  const lifecyclePath = join(root, 'lifecycle.json');
  const repairId = randomUUID();
  const createdPayload = { baseCommit: 'a'.repeat(40) };
  const baselinePayload = {
    command: 'verify:promise:race',
    expectedViolation: 'PP_IDENTIFIABLE_EVENT_LEAK',
  };

  const first = await appendRepairLifecycle(
    lifecyclePath,
    repairId,
    'created',
    createdPayload,
  );
  const second = await appendRepairLifecycle(
    lifecyclePath,
    repairId,
    'baseline_verified',
    baselinePayload,
  );

  assert.equal(first.schemaVersion, REPAIR_LIFECYCLE_VERSION);
  assert.equal(first.events.length, 1);
  assert.equal(second.events.length, 2);
  assert.deepEqual(
    second.events.map((event) => [event.sequence, event.state]),
    [
      [1, 'created'],
      [2, 'baseline_verified'],
    ],
  );
  assert.equal(second.events[0]!.previousEventSha256, null);
  assert.equal(
    second.events[1]!.previousEventSha256,
    second.events[0]!.eventSha256,
  );
  assert.equal(
    second.events[0]!.payloadSha256,
    sha256CanonicalJson(createdPayload),
  );
  assert.equal(
    second.events[1]!.payloadSha256,
    sha256CanonicalJson(baselinePayload),
  );
  assert.equal(Object.isFrozen(second), true);
  assert.equal(Object.isFrozen(second.events), true);

  const persisted = JSON.parse(await readFile(lifecyclePath, 'utf8')) as unknown;
  assert.deepEqual(validateRepairLifecycle(persisted), second);
});

test('rejects a changed repair ID and preserves the existing lifecycle', async () => {
  const root = await temporaryRoot();
  const lifecyclePath = join(root, 'lifecycle.json');
  const repairId = randomUUID();
  await appendRepairLifecycle(lifecyclePath, repairId, 'created', {
    step: 1,
  });
  const before = await readFile(lifecyclePath, 'utf8');

  await assert.rejects(
    appendRepairLifecycle(
      lifecyclePath,
      randomUUID(),
      'baseline_verified',
      { step: 2 },
    ),
    /PP_REPAIR_LIFECYCLE_INVALID: repair ID changed\./u,
  );
  assert.equal(await readFile(lifecyclePath, 'utf8'), before);
});

test('detects sequence, link, content-hash, and lifecycle repair-ID tampering', async () => {
  const root = await temporaryRoot();
  const lifecyclePath = join(root, 'lifecycle.json');
  const repairId = randomUUID();
  const lifecycle = await appendRepairLifecycle(
    lifecyclePath,
    repairId,
    'created',
    { step: 1 },
  );
  const complete = await appendRepairLifecycle(
    lifecyclePath,
    repairId,
    'baseline_verified',
    { step: 2 },
  );

  const mutations: Array<(value: Record<string, unknown>) => void> = [
    (value) => {
      const events = value.events as Array<Record<string, unknown>>;
      events[1]!.sequence = 4;
    },
    (value) => {
      const events = value.events as Array<Record<string, unknown>>;
      events[1]!.previousEventSha256 = 'f'.repeat(64);
    },
    (value) => {
      const events = value.events as Array<Record<string, unknown>>;
      events[0]!.state = 'cleanup_completed';
    },
    (value) => {
      value.repairId = randomUUID();
    },
  ];

  for (const mutate of mutations) {
    const value = structuredClone(complete) as unknown as Record<string, unknown>;
    mutate(value);
    assert.throws(
      () => validateRepairLifecycle(value),
      /PP_REPAIR_LIFECYCLE_INVALID/u,
    );
  }

  const onDisk = structuredClone(complete) as unknown as Record<string, unknown>;
  const onDiskEvents = onDisk.events as Array<Record<string, unknown>>;
  onDiskEvents[0]!.payloadSha256 = '0'.repeat(64);
  await writeFile(lifecyclePath, `${JSON.stringify(onDisk)}\n`, 'utf8');
  await assert.rejects(
    appendRepairLifecycle(lifecyclePath, repairId, 'codex_completed', {}),
    /PP_REPAIR_LIFECYCLE_INVALID/u,
  );

  assert.equal(lifecycle.events[0]!.sequence, 1);
});

test('rejects an illegal lifecycle transition even when every hash is recomputed', async () => {
  const root = await temporaryRoot();
  const lifecyclePath = join(root, 'lifecycle.json');
  const repairId = randomUUID();
  const created = await appendRepairLifecycle(
    lifecyclePath,
    repairId,
    'created',
    { step: 1 },
  );
  const base = {
    sequence: 2,
    repairId,
    state: 'verification_passed' as const,
    recordedAt: '2026-07-15T10:00:01.000Z',
    previousEventSha256: created.events[0]!.eventSha256,
    payloadSha256: sha256CanonicalJson({ forged: true }),
  };
  const forged = {
    schemaVersion: REPAIR_LIFECYCLE_VERSION,
    repairId,
    events: [
      created.events[0],
      { ...base, eventSha256: sha256CanonicalJson(base) },
    ],
  };
  assert.throws(
    () => validateRepairLifecycle(forged),
    /state transition is not allowed/u,
  );
});

test('writeNewJson never overwrites an existing decision artifact', async () => {
  const root = await temporaryRoot();
  const filePath = join(root, 'decision.json');
  const original = { decision: 'approved', marker: 'first' };
  await writeNewJson(filePath, original);

  await assert.rejects(
    writeNewJson(filePath, { decision: 'rejected', marker: 'second' }),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'EEXIST',
  );
  assert.deepEqual(
    JSON.parse(await readFile(filePath, 'utf8')) as unknown,
    original,
  );
});

test('local state writes atomically, round-trips, replaces, and rejects bad headers', async () => {
  const root = await temporaryRoot();
  const statePath = join(root, 'state.json');
  const original = stateFixture(root);
  await writeLocalRepairState(statePath, original);

  const firstRead = await readLocalRepairState(statePath);
  assert.deepEqual(firstRead, original);
  assert.equal(Object.isFrozen(firstRead), true);
  assert.equal(Object.isFrozen(firstRead.eligibility), true);
  assert.equal(canonicalStateSha256(firstRead), sha256CanonicalJson(original));

  const updated: LocalRepairStateV1 = {
    ...original,
    state: 'baseline_verified',
    updatedAt: '2026-07-15T10:01:00.000Z',
  };
  await writeLocalRepairState(statePath, updated);
  assert.deepEqual(await readLocalRepairState(statePath), updated);

  for (const malformed of [
    null,
    {},
    { ...updated, schemaVersion: 'future-version' },
    { ...updated, repairId: 42 },
    { ...updated, repairId: 'not-a-uuid' },
    { ...updated, state: 'model_says_passed' },
    { ...updated, patchPath: join(root, 'outside.patch') },
    { ...updated, approvalPath: join(root, 'outside-decision.json') },
    { ...updated, eligibility: {} },
    {
      ...updated,
      frozenFoundation: {
        ...updated.frozenFoundation,
        baseCommit: 'c'.repeat(40),
      },
    },
    { ...updated, unexpectedAuthority: 'model' },
  ]) {
    await writeFile(statePath, `${JSON.stringify(malformed)}\n`, 'utf8');
    await assert.rejects(
      readLocalRepairState(statePath),
      /PP_REPAIR_LOCAL_STATE_INVALID/u,
    );
  }
});

test('accepts only the exact APPROVE or REJECT phrase for the current digest', () => {
  const repairId = randomUUID();
  const patchSha256 = 'a'.repeat(64);

  assert.equal(
    parseReviewPhrase(
      expectedReviewPhrase('APPROVE', repairId, patchSha256),
      repairId,
      patchSha256,
    ),
    'approved',
  );
  assert.equal(
    parseReviewPhrase(
      expectedReviewPhrase('REJECT', repairId, patchSha256),
      repairId,
      patchSha256,
    ),
    'rejected',
  );

  const staleDigest = 'b'.repeat(64);
  const wrongRepairId = randomUUID();
  const invalidPhrases = [
    expectedReviewPhrase('APPROVE', repairId, staleDigest),
    expectedReviewPhrase('APPROVE', wrongRepairId, patchSha256),
    expectedReviewPhrase('APPROVE', repairId, patchSha256.toUpperCase()),
    `approve ${repairId} ${patchSha256}`,
    ` APPROVE ${repairId} ${patchSha256}`,
    `APPROVE  ${repairId} ${patchSha256}`,
    `APPROVE ${repairId} ${patchSha256} `,
    `APPROVE\t${repairId}\t${patchSha256}`,
    `APPROVE ${repairId} ${patchSha256}\n`,
    `APPROVE ${repairId} ${patchSha256} extra`,
    `REJECT ${repairId} ${staleDigest}`,
  ];

  for (const phrase of invalidPhrases) {
    assert.throws(
      () => parseReviewPhrase(phrase, repairId, patchSha256),
      /PP_REPAIR_REVIEW_PHRASE_INVALID/u,
    );
  }
});

test('human decision artifacts are schema-validated, immutable, and content-addressable', async () => {
  const root = await temporaryRoot();
  const approvalPath = join(root, 'approval.json');
  const repairId = randomUUID();
  const patchSha256 = 'c'.repeat(64);
  const phrase = expectedReviewPhrase('APPROVE', repairId, patchSha256);
  const record = humanRepairDecisionSchema.parse({
    schemaVersion: REPAIR_APPROVAL_VERSION,
    repairId,
    decision: 'approved',
    patchSha256,
    patchBytes: 512,
    decidedAt: '2026-07-15T10:02:00.000Z',
    reviewer: 'human_operator',
    method: 'interactive_tty_exact_phrase',
    confirmationSha256: sha256Bytes(phrase),
  });
  assert.throws(() =>
    humanRepairDecisionSchema.parse({
      ...record,
      confirmationSha256: sha256Bytes(
        `offline-test-only ${repairId} ${patchSha256}`,
      ),
    }),
  );
  await writeNewJson(approvalPath, record);

  const read = await readHumanDecision(approvalPath);
  assert.deepEqual(read, record);
  assert.equal(Object.isFrozen(read), true);

  await writeFile(
    approvalPath,
    `${JSON.stringify({ ...record, passed: true })}\n`,
    'utf8',
  );
  await assert.rejects(readHumanDecision(approvalPath));
});
