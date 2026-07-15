import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  aggregateUsage,
  type InvestigationArtifactV1,
} from '../src/investigation/artifact.js';
import { sha256CanonicalJson } from '../src/investigation/canonical-json.js';
import { runInvestigation } from '../src/investigation/runner.js';
import type { PromiseEvidence } from '../src/shared/types.js';
import { DeterministicInvestigationProvider } from '../tests/support/deterministic-investigation-provider.js';
import {
  DEFAULT_STABILITY_PATHS,
  captureLiveSourceSnapshot,
  computeSourceSnapshot,
  discoverLiveArtifacts,
  requirePassedLastRun,
  requireUnchangedSourceSnapshot,
  runLiveStabilityVerification,
  verifyLiveStabilityArtifacts,
} from './verify-live-stability.js';

type EvidenceSignature = 'race' | 'propagation';
type CompletedInvestigationArtifact = InvestigationArtifactV1 & {
  status: 'investigation_completed';
  initialOutput: NonNullable<InvestigationArtifactV1['initialOutput']>;
  replay: NonNullable<InvestigationArtifactV1['replay']>;
  finalOutput: NonNullable<InvestigationArtifactV1['finalOutput']>;
};

const UNIT_API_KEY_RAW = '  unit-api-credential-that-must-never-be-retained  ';
const UNIT_API_KEY_TRIMMED = UNIT_API_KEY_RAW.trim();
const SOURCE_SNAPSHOT = {
  sha256: 'a'.repeat(64),
  fileCount: 42,
};

function activityEvidence(): PromiseEvidence {
  const payload = {
    runId: 'synthetic-run',
    userId: 'synthetic-subject',
    eventType: 'page_view' as const,
    itemId: 'startup-item',
    clientSequence: 1,
    occurredAt: '2026-07-15T12:00:00.000Z',
  };
  const recommendationItem = {
    id: 'context-card-1',
    title: 'Context card',
    description: 'A deterministic contextual recommendation.',
    eyebrow: 'Context',
  };

  return {
    scenario: 'off',
    runId: 'synthetic-run',
    userId: 'synthetic-subject',
    ui: {
      preference: 'off',
      toggleChecked: false,
      feedFunctional: true,
    },
    storage: { preference: 'off' },
    request: {
      activityPayloads: [payload],
      preferenceUpdates: [],
    },
    response: { preferenceUpdates: [] },
    backend: {
      preference: 'off',
      activityReceipts: [
        {
          kind: 'activity',
          service: 'recommendation',
          receiptId: 'activity-receipt-1',
          sequence: 1,
          receivedAt: '2026-07-15T12:00:00.010Z',
          payload,
        },
      ],
      recommendationReceipts: [
        {
          kind: 'recommendation',
          receiptId: 'recommendation-receipt-1',
          sequence: 2,
          receivedAt: '2026-07-15T12:00:00.020Z',
          source: 'contextual',
          items: [recommendationItem],
        },
      ],
      preferenceReceipts: [],
    },
    recommendation: {
      source: 'contextual',
      itemIds: [recommendationItem.id],
    },
    timestamps: {
      clientTimeline: [
        {
          sequence: 1,
          event: 'collector_started',
          timestamp: '2026-07-15T12:00:00.000Z',
        },
        {
          sequence: 2,
          event: 'activity_dispatched',
          timestamp: '2026-07-15T12:00:00.005Z',
        },
        {
          sequence: 3,
          event: 'activity_received',
          timestamp: '2026-07-15T12:00:00.010Z',
        },
        {
          sequence: 4,
          event: 'preference_hydration_started',
          timestamp: '2026-07-15T12:00:00.011Z',
        },
        {
          sequence: 5,
          event: 'preference_hydration_completed',
          timestamp: '2026-07-15T12:00:00.015Z',
        },
        {
          sequence: 6,
          event: 'recommendation_rendered',
          timestamp: '2026-07-15T12:00:00.020Z',
        },
      ],
      activityReceivedAt: ['2026-07-15T12:00:00.010Z'],
      preferenceReceivedAt: [],
      recommendationReceivedAt: ['2026-07-15T12:00:00.020Z'],
    },
    journey: { reloadObserved: true },
  };
}

function preferenceEvidence(): PromiseEvidence {
  const evidence = structuredClone(activityEvidence());
  evidence.request.activityPayloads = [];
  evidence.backend.activityReceipts = [];
  evidence.backend.preference = 'on';
  evidence.timestamps.activityReceivedAt = [];
  evidence.timestamps.clientTimeline = [
    {
      sequence: 1,
      event: 'preference_sync_dispatched',
      timestamp: '2026-07-15T12:00:00.000Z',
    },
    {
      sequence: 2,
      event: 'preference_sync_acknowledged',
      timestamp: '2026-07-15T12:00:00.010Z',
    },
    {
      sequence: 3,
      event: 'backend_preference_observed',
      timestamp: '2026-07-15T12:00:00.020Z',
    },
    {
      sequence: 4,
      event: 'recommendation_rendered',
      timestamp: '2026-07-15T12:00:00.030Z',
    },
  ];
  return evidence;
}

function startupReport() {
  return {
    events: [
      'collector_started',
      'activity_dispatched',
      'activity_received',
      'preference_hydration_started',
      'preference_hydration_completed',
      'recommendation_rendered',
    ],
    collectorIndex: 0,
    hydrationIndex: 3,
    collectorBeforeHydration: true,
    activityRequestCount: 1,
    activityReceiptCount: 1,
    networkEvents: ['activity_post', 'preference_read'],
    activityBeforePreferenceRead: true,
  } as const;
}

function preferenceReport() {
  return {
    requested: 'off',
    acknowledged: 'off',
    authoritativeReadback: 'on',
    receiptRecorded: true,
    identityCorrelated: true,
    roundtripConsistent: false,
  } as const;
}

function investigationUuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

async function makeLiveArtifact(
  signature: EvidenceSignature,
  index: number,
): Promise<CompletedInvestigationArtifact> {
  let now = Date.UTC(2026, 6, 15, 12, 0, index);
  const artifact = await runInvestigation({
    evidence:
      signature === 'race' ? activityEvidence() : preferenceEvidence(),
    provider: new DeterministicInvestigationProvider(),
    replayExecutors: {
      inspect_startup_order: async () => startupReport(),
      inspect_preference_roundtrip: async () => preferenceReport(),
    },
    investigationId: investigationUuid(index),
    now: () => {
      now += 10;
      return now;
    },
  });
  assert.equal(artifact.status, 'investigation_completed');

  const live = structuredClone(artifact) as CompletedInvestigationArtifact;
  live.provider.kind = 'openai';
  live.provider.responses = live.provider.responses.map(
    (response, responseIndex) => {
      const inputTokens = 100 + index + responseIndex;
      const outputTokens = 20 + responseIndex;
      return {
        ...response,
        responseId: `resp_unit_${signature}_${index}_${responseIndex}`,
        model: responseIndex === 0 ? 'gpt-5.6' : 'gpt-5.6-sol',
        latencyMs: 5 + index + responseIndex,
        usage: {
          inputTokens,
          cachedInputTokens: 10,
          outputTokens,
          reasoningTokens: 5,
          totalTokens: inputTokens + outputTokens,
        },
      };
    },
  );
  live.provider.aggregateUsage = aggregateUsage(live.provider.responses);
  return live;
}

let fixturePromise:
  | Promise<{
      race: CompletedInvestigationArtifact[];
      propagation: CompletedInvestigationArtifact[];
    }>
  | undefined;

async function cohortFixture() {
  fixturePromise ??= Promise.all([
    Promise.all([1, 2, 3].map((index) => makeLiveArtifact('race', index))),
    Promise.all(
      [4, 5, 6].map((index) => makeLiveArtifact('propagation', index)),
    ),
  ]).then(([race, propagation]) => ({ race, propagation }));
  return fixturePromise;
}

async function validInputs() {
  const fixture = await cohortFixture();
  return {
    raceArtifacts: structuredClone(fixture.race),
    propagationArtifacts: structuredClone(fixture.propagation),
    sourceSnapshot: { ...SOURCE_SNAPSHOT },
    credentialCandidates: [UNIT_API_KEY_RAW, UNIT_API_KEY_TRIMMED],
  };
}

function assertInvalid(action: () => unknown, message?: RegExp): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith('PP_LIVE_STABILITY_INVALID:') &&
      (message === undefined || message.test(error.message)),
  );
}

async function assertInvalidAsync(
  action: () => Promise<unknown>,
  message?: RegExp,
): Promise<void> {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof Error &&
      error.message.startsWith('PP_LIVE_STABILITY_INVALID:') &&
      (message === undefined || message.test(error.message)),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('a valid three-plus-three live cohort produces only a sanitized receipt', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('Network access is forbidden in live-stability unit tests.');
  }) as typeof fetch;

  try {
    const inputs = await validInputs();
    const receipt = verifyLiveStabilityArtifacts(inputs);
    assert.equal(fetchCalls, 0);
    assert.equal(receipt.totalRuns, 6);
    assert.equal(receipt.totalResponses, 12);
    assert.equal(receipt.requiredRunsPerEvidenceSignature, 3);
    assert.equal(receipt.groups[0]!.runCount, 3);
    assert.equal(receipt.groups[1]!.runCount, 3);
    assert.equal(receipt.groups[0]!.responseCount, 6);
    assert.equal(receipt.groups[1]!.responseCount, 6);
    assert.equal(
      receipt.aggregateUsage.totalTokens,
      receipt.groups.reduce(
        (total, group) => total + group.aggregateUsage.totalTokens,
        0,
      ),
    );
    assert.equal(
      receipt.aggregateLatencyMs,
      receipt.groups.reduce(
        (total, group) => total + group.aggregateLatencyMs,
        0,
      ),
    );

    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(UNIT_API_KEY_RAW), false);
    assert.equal(serialized.includes(UNIT_API_KEY_TRIMMED), false);
    assert.equal(
      serialized.includes(
        inputs.raceArtifacts[0]!.initialOutput.hypotheses[0]!.title,
      ),
      false,
      'model-authored hypothesis prose must not enter the aggregate receipt',
    );
    assert.doesNotMatch(serialized, /(?:src[\\/]|tests[\\/]|\.webm|trace\.zip)/i);
    assert.match(
      serialized,
      /canonical_sha256_consistency_not_provider_origin_attestation/,
    );
    assert.match(serialized, /deterministic_typescript_and_playwright_only/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('cohort cardinality, UUIDs, response IDs, and dossier stability are exact', async () => {
  const missing = await validInputs();
  missing.raceArtifacts.pop();
  assertInvalid(() => verifyLiveStabilityArtifacts(missing), /Exactly three/);

  const duplicateInvestigation = await validInputs();
  duplicateInvestigation.propagationArtifacts[0]!.investigationId =
    duplicateInvestigation.raceArtifacts[0]!.investigationId;
  assertInvalid(
    () => verifyLiveStabilityArtifacts(duplicateInvestigation),
    /Investigation IDs/,
  );

  const duplicateResponse = await validInputs();
  duplicateResponse.propagationArtifacts[2]!.provider.responses[1]!.responseId =
    duplicateResponse.raceArtifacts[0]!.provider.responses[0]!.responseId;
  assertInvalid(
    () => verifyLiveStabilityArtifacts(duplicateResponse),
    /Response IDs/,
  );

  const unstableDossier = await validInputs();
  unstableDossier.raceArtifacts[1]!.dossier.recommendation.itemCount += 1;
  unstableDossier.raceArtifacts[1]!.dossierSha256 = sha256CanonicalJson(
    unstableDossier.raceArtifacts[1]!.dossier,
  );
  assertInvalid(
    () => verifyLiveStabilityArtifacts(unstableDossier),
    /one deterministic dossier digest/,
  );

  const sharedDossier = await validInputs();
  for (const artifact of sharedDossier.propagationArtifacts) {
    artifact.dossier = structuredClone(sharedDossier.raceArtifacts[0]!.dossier);
    artifact.dossierSha256 = sha256CanonicalJson(artifact.dossier);
  }
  assertInvalid(() => verifyLiveStabilityArtifacts(sharedDossier));
});

test('wrong violations, replay identities, factual counts, and normalized replay facts are rejected', async () => {
  const wrongViolation = await validInputs();
  wrongViolation.raceArtifacts[0]!.dossier.violationCodes = [
    'PP_PREFERENCE_NOT_PERSISTED',
  ];
  wrongViolation.raceArtifacts[0]!.dossierSha256 = sha256CanonicalJson(
    wrongViolation.raceArtifacts[0]!.dossier,
  );
  assertInvalid(
    () => verifyLiveStabilityArtifacts(wrongViolation),
    /expected singleton violation/,
  );

  const wrongReplay = await validInputs();
  wrongReplay.raceArtifacts[0]!.initialOutput.replayId =
    'inspect_preference_roundtrip';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(wrongReplay),
    /replay identities/,
  );

  const duplicateLeak = await validInputs();
  duplicateLeak.raceArtifacts[0]!.dossier.activity.requestCount = 2;
  duplicateLeak.raceArtifacts[0]!.dossier.activity.identifiableRequestCount = 2;
  duplicateLeak.raceArtifacts[0]!.dossierSha256 = sha256CanonicalJson(
    duplicateLeak.raceArtifacts[0]!.dossier,
  );
  assertInvalid(
    () => verifyLiveStabilityArtifacts(duplicateLeak),
    /complete factual signature/,
  );

  const propagationActivity = await validInputs();
  propagationActivity.propagationArtifacts[0]!.dossier.activity.requestCount = 1;
  propagationActivity.propagationArtifacts[0]!.dossierSha256 =
    sha256CanonicalJson(propagationActivity.propagationArtifacts[0]!.dossier);
  assertInvalid(
    () => verifyLiveStabilityArtifacts(propagationActivity),
    /complete factual signature/,
  );

  const denormalizedReplay = await validInputs();
  denormalizedReplay.raceArtifacts[0]!.replay.evidenceReferences[0]!.description =
    'A model-authored replacement for deterministic replay evidence.';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(denormalizedReplay),
    /exact normalized factual projection/,
  );
});

test('provider response shape, usage, timing, and aggregate arithmetic are independently checked', async () => {
  const malformedItem = await validInputs();
  malformedItem.raceArtifacts[0]!.provider.responses[0]!.outputItems.push({
    type: 'message',
    status: 'completed',
    contentTypes: ['output_text'],
  });
  assertInvalid(
    () => verifyLiveStabilityArtifacts(malformedItem),
    /bounded tool flow/,
  );

  const zeroUsage = await validInputs();
  const zeroResponse = zeroUsage.raceArtifacts[0]!.provider.responses[0]!;
  zeroResponse.usage.inputTokens = 0;
  zeroResponse.usage.cachedInputTokens = 0;
  zeroResponse.usage.totalTokens = zeroResponse.usage.outputTokens;
  zeroUsage.raceArtifacts[0]!.provider.aggregateUsage = aggregateUsage(
    zeroUsage.raceArtifacts[0]!.provider.responses,
  );
  assertInvalid(
    () => verifyLiveStabilityArtifacts(zeroUsage),
    /zero required token usage/,
  );

  const wrongAggregate = await validInputs();
  wrongAggregate.raceArtifacts[0]!.provider.aggregateUsage.totalTokens += 1;
  assertInvalid(() => verifyLiveStabilityArtifacts(wrongAggregate));

  const invalidCachedUsage = await validInputs();
  invalidCachedUsage.raceArtifacts[0]!.provider.responses[0]!.usage.cachedInputTokens =
    10_000;
  assertInvalid(() => verifyLiveStabilityArtifacts(invalidCachedUsage));

  const malformedLatency = await validInputs();
  malformedLatency.raceArtifacts[0]!.provider.responses[0]!.latencyMs =
    Number.NaN;
  assertInvalid(() => verifyLiveStabilityArtifacts(malformedLatency));

  const replayExceedsTotal = await validInputs();
  replayExceedsTotal.raceArtifacts[0]!.timing.replayMs =
    replayExceedsTotal.raceArtifacts[0]!.timing.totalMs + 1;
  assertInvalid(
    () => verifyLiveStabilityArtifacts(replayExceedsTotal),
    /timing was reversed or internally inconsistent/,
  );
});

test('initial rankings, grounding, exact accepted decisions, and final replay grounding are revalidated', async () => {
  const swappedRanks = await validInputs();
  swappedRanks.raceArtifacts[0]!.initialOutput.hypotheses[0]!.rank = 2;
  swappedRanks.raceArtifacts[0]!.initialOutput.hypotheses[1]!.rank = 1;
  assertInvalid(
    () => verifyLiveStabilityArtifacts(swappedRanks),
    /rank or descending confidence/,
  );

  const ascendingConfidence = await validInputs();
  ascendingConfidence.raceArtifacts[0]!.initialOutput.hypotheses[1]!.confidence =
    99;
  assertInvalid(
    () => verifyLiveStabilityArtifacts(ascendingConfidence),
    /rank or descending confidence/,
  );

  const danglingInitialReference = await validInputs();
  danglingInitialReference.raceArtifacts[0]!.initialOutput.hypotheses[0]!
    .supportingEvidence[0] = 'fact.not_in_dossier';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(danglingInitialReference),
    /outside the dossier/,
  );

  const alteredDecision = await validInputs();
  alteredDecision.raceArtifacts[0]!.toolValidation.decisions[0]!.code =
    'PP_INV_DIFFERENT_ACCEPTED';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(alteredDecision),
    /validation sequence/,
  );

  const ungroundedLeader = await validInputs();
  const leading = ungroundedLeader.raceArtifacts[0]!.finalOutput.hypotheses[0]!;
  leading.supportingEvidenceReferences = leading.supportingEvidenceReferences.filter(
    (reference) => !reference.startsWith('replay.'),
  );
  assertInvalid(
    () => verifyLiveStabilityArtifacts(ungroundedLeader),
    /leading hypothesis/,
  );
});

test('dossier hash, fixture markers, both key forms, and model verdict claims cannot survive the gate', async () => {
  const hashMismatch = await validInputs();
  hashMismatch.raceArtifacts[0]!.dossierSha256 = 'b'.repeat(64);
  assertInvalid(
    () => verifyLiveStabilityArtifacts(hashMismatch),
    /dossier digest/,
  );

  const fixtureLeak = await validInputs();
  fixtureLeak.raceArtifacts[0]!.initialOutput.hypotheses[0]!.title =
    'The initialization-race fixture selected this diagnosis';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(fixtureLeak),
    /forbidden fixture/,
  );

  for (const credential of [UNIT_API_KEY_RAW, UNIT_API_KEY_TRIMMED]) {
    const keyLeak = await validInputs();
    keyLeak.raceArtifacts[0]!.initialOutput.hypotheses[0]!.title = credential;
    assertInvalid(
      () => verifyLiveStabilityArtifacts(keyLeak),
      /configured API credential/,
    );
  }

  const verdictClaim = await validInputs();
  verdictClaim.raceArtifacts[0]!.initialOutput.hypotheses[0]!.title =
    'The promise is verified';
  assertInvalid(
    () => verifyLiveStabilityArtifacts(verdictClaim),
    /reserved product-outcome claim/,
  );
});

test('artifact discovery accepts only three exact basenames outside attachment trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-discovery-'));
  try {
    for (const run of ['run-a', 'run-b', 'run-c']) {
      await writeJson(
        join(root, run, 'promiseproof-live-investigation.json'),
        { run },
      );
    }
    await writeJson(
      join(root, 'run-a', 'attachments', 'promiseproof-live-investigation.json'),
      { ignored: true },
    );
    await writeJson(
      join(root, 'run-b', 'Attachments', 'promiseproof-live-investigation.json'),
      { ignored: true },
    );
    await writeJson(
      join(root, 'run-c', 'promiseproof-live-investigation.json.bak'),
      { ignored: true },
    );
    await writeJson(join(root, '.last-run.json'), {
      status: 'passed',
      failedTests: [],
    });

    const matches = await discoverLiveArtifacts(root);
    assert.equal(matches.length, 3);
    assert.equal(matches.every((path) => !/attachments/i.test(path)), true);
    await requirePassedLastRun(root);

    await rm(matches[0]!);
    await assertInvalidAsync(
      () => discoverLiveArtifacts(root),
      /three distinct exact artifacts/,
    );

    await writeJson(join(root, '.last-run.json'), {
      status: 'failed',
      failedTests: ['opaque-test-id'],
    });
    await assertInvalidAsync(
      () => requirePassedLastRun(root),
      /clean passed stability invocation/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const absent = join(tmpdir(), 'promiseproof-definitely-absent-output');
  await rm(absent, { recursive: true, force: true });
  await assertInvalidAsync(
    () => discoverLiveArtifacts(absent),
    /absent or unreadable/,
  );
  await assertInvalidAsync(
    () => requirePassedLastRun(absent),
    /no readable last-run/,
  );
});

async function createSnapshotProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'promiseproof-source-snapshot-'));
  for (const directory of ['src', 'tests', 'scripts']) {
    await mkdir(join(root, directory), { recursive: true });
    await writeFile(join(root, directory, `${directory}.ts`), `${directory}\n`, 'utf8');
  }
  for (const filename of [
    'index.html',
    'package.json',
    'package-lock.json',
    'playwright.config.ts',
    'tsconfig.json',
    'vite.config.ts',
  ]) {
    await writeFile(join(root, filename), `${filename}\n`, 'utf8');
  }
  return root;
}

test('source preflight removes stale receipts and cohorts, then binds verification to unchanged files', async () => {
  const root = await createSnapshotProject();
  const receiptPath = join(root, DEFAULT_STABILITY_PATHS.receipt);
  const snapshotPath = join(root, DEFAULT_STABILITY_PATHS.sourceSnapshot);
  const raceOutputPath = join(root, DEFAULT_STABILITY_PATHS.race);
  const propagationOutputPath = join(
    root,
    DEFAULT_STABILITY_PATHS.propagation,
  );
  try {
    await writeJson(receiptPath, { stale: 'green' });
    await writeJson(join(raceOutputPath, '.last-run.json'), {
      status: 'passed',
      failedTests: [],
    });
    await writeJson(join(propagationOutputPath, '.last-run.json'), {
      status: 'passed',
      failedTests: [],
    });
    const before = await computeSourceSnapshot(root);
    assert.equal(before.fileCount, 9);
    assert.match(before.sha256, /^[a-f0-9]{64}$/);

    assert.equal(await captureLiveSourceSnapshot(root), snapshotPath);
    await assert.rejects(() => stat(receiptPath), { code: 'ENOENT' });
    await assert.rejects(() => stat(raceOutputPath), { code: 'ENOENT' });
    await assert.rejects(() => stat(propagationOutputPath), {
      code: 'ENOENT',
    });
    assert.deepEqual(await requireUnchangedSourceSnapshot(root), before);
    await stat(snapshotPath);

    await writeFile(join(root, 'src', 'src.ts'), 'source changed\n', 'utf8');
    await assertInvalidAsync(
      () => requireUnchangedSourceSnapshot(root),
      /sources changed after the live-stability preflight/,
    );

    await rm(snapshotPath, { force: true });
    await assertInvalidAsync(
      () => requireUnchangedSourceSnapshot(root),
      /pre-run execution source snapshot was absent/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the filesystem verifier atomically writes a sanitized receipt without network access', async () => {
  const root = await createSnapshotProject();
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.OPENAI_API_KEY = UNIT_API_KEY_RAW;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error('Network access is forbidden in live-stability unit tests.');
  }) as typeof fetch;

  try {
    const inputs = await validInputs();
    await captureLiveSourceSnapshot(root);
    for (const [directory, artifacts] of [
      [DEFAULT_STABILITY_PATHS.race, inputs.raceArtifacts],
      [DEFAULT_STABILITY_PATHS.propagation, inputs.propagationArtifacts],
    ] as const) {
      const output = join(root, directory);
      await writeJson(join(output, '.last-run.json'), {
        status: 'passed',
        failedTests: [],
      });
      for (const [index, artifact] of artifacts.entries()) {
        await writeJson(
          join(
            output,
            `run-${index + 1}`,
            'promiseproof-live-investigation.json',
          ),
          artifact,
        );
      }
    }

    const outputPath = await runLiveStabilityVerification(root);
    assert.equal(outputPath, join(root, DEFAULT_STABILITY_PATHS.receipt));
    const receipt = JSON.parse(await readFile(outputPath, 'utf8')) as {
      totalRuns?: unknown;
      totalResponses?: unknown;
    };
    assert.equal(receipt.totalRuns, 6);
    assert.equal(receipt.totalResponses, 12);
    assert.equal(fetchCalls, 0);
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes(UNIT_API_KEY_RAW), false);
    assert.equal(serialized.includes(UNIT_API_KEY_TRIMMED), false);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('source snapshot input itself must be a real positive canonical digest shape', async () => {
  const inputs = await validInputs();
  inputs.sourceSnapshot = { sha256: 'not-a-sha', fileCount: 0 };
  assertInvalid(
    () => verifyLiveStabilityArtifacts(inputs),
    /source snapshot was absent or invalid/,
  );

  const liveProjectSnapshot = await computeSourceSnapshot(
    fileURLToPath(new URL('..', import.meta.url)),
  );
  assert.match(liveProjectSnapshot.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Number.isInteger(liveProjectSnapshot.fileCount), true);
  assert.ok(liveProjectSnapshot.fileCount > 0);
});
