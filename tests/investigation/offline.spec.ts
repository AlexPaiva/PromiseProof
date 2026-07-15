import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

import type { DiagnosticReplayId } from '../../src/investigation/contracts.js';
import { runInvestigation } from '../../src/investigation/runner.js';
import type { PromiseEvidence } from '../../src/shared/types.js';
import { DeterministicInvestigationProvider } from '../support/deterministic-investigation-provider.js';
import { createInvestigationReplayExecutors } from '../support/investigation-replays.js';
import { runPromiseScenario } from '../support/scenario.js';

function expectedReplayFromObservedFacts(
  evidence: PromiseEvidence,
): DiagnosticReplayId {
  const identifiableRequestCount = evidence.request.activityPayloads.filter(
    (payload) => payload.userId.length > 0,
  ).length;
  const identifiableReceiptCount = evidence.backend.activityReceipts.filter(
    (receipt) => receipt.payload.userId.length > 0,
  ).length;

  if (identifiableRequestCount > 0 || identifiableReceiptCount > 0) {
    return 'inspect_startup_order';
  }

  if (
    evidence.ui.preference === 'off' &&
    evidence.storage.preference === 'off' &&
    evidence.backend.preference === 'on'
  ) {
    return 'inspect_preference_roundtrip';
  }

  throw new Error('The observation did not match a supported evidence signature.');
}

test('offline provider completes one bounded investigation from real OFF evidence', async ({
  page,
  request,
}, testInfo) => {
  const observationIds = {
    runId: 'offline-observation-001',
    userId: 'synthetic-subject-201',
  };
  const replayIds = {
    runId: 'offline-diagnostic-001',
    userId: 'synthetic-subject-202',
  };
  const observation = await runPromiseScenario(
    page,
    request,
    testInfo,
    'off',
    observationIds,
  );
  expect(observation.browserErrors).toEqual([]);
  const expectedReplay = expectedReplayFromObservedFacts(observation.evidence);
  const provider = new DeterministicInvestigationProvider();
  const artifact = await runInvestigation({
    evidence: observation.evidence,
    provider,
    replayExecutors: createInvestigationReplayExecutors(
      page,
      request,
      testInfo,
      replayIds,
    ),
    investigationId: 'offline-investigation-001',
  });

  expect(artifact.status).toBe('investigation_completed');
  expect(artifact.failure).toBeNull();
  expect(artifact.provider.kind).toBe('offline');
  expect(artifact.provider.responses).toHaveLength(2);
  expect(artifact.bounds).toEqual({
    maxProviderCalls: 2,
    providerCallsUsed: 2,
    maxReplayExecutions: 1,
    replayExecutionsUsed: 1,
  });
  expect(artifact.toolValidation.accepted).toBe(true);
  expect(artifact.initialOutput?.replayId).toBe(expectedReplay);
  expect(artifact.replay?.replayId).toBe(expectedReplay);
  expect(artifact.finalOutput?.replayPerformed).toBe(expectedReplay);
  expect(provider.replayRequests).toHaveLength(1);
  expect(provider.conclusionRequests).toHaveLength(1);

  const replayReferenceIds = new Set(
    artifact.replay?.evidenceReferences.map((reference) => reference.id) ?? [],
  );
  expect(replayReferenceIds.size).toBeGreaterThan(0);
  expect(
    artifact.finalOutput?.conclusionEvidenceReferences.some((reference) =>
      replayReferenceIds.has(reference),
    ),
  ).toBe(true);
  expect(
    artifact.finalOutput?.hypotheses.some(
      (hypothesis) => hypothesis.status !== 'unresolved',
    ),
  ).toBe(true);
  expect(
    artifact.finalOutput?.hypotheses.some(
      (hypothesis) =>
        hypothesis.hypothesisId ===
        artifact.finalOutput?.mostLikelyHypothesisId,
    ),
  ).toBe(true);

  const exactProviderInput = JSON.stringify({
    initial: provider.replayRequests,
    final: provider.conclusionRequests,
  });
  expect(exactProviderInput).not.toContain('initialization-race');
  expect(exactProviderInput).not.toContain('propagation-failure');
  expect(exactProviderInput).not.toContain('DEMO_MODE');
  expect(exactProviderInput).not.toContain(observationIds.runId);
  expect(exactProviderInput).not.toContain(observationIds.userId);
  expect(exactProviderInput).not.toContain(replayIds.runId);
  expect(exactProviderInput).not.toContain(replayIds.userId);

  const serializedArtifact = JSON.stringify(artifact);
  expect(serializedArtifact).not.toContain('initialization-race');
  expect(serializedArtifact).not.toContain('propagation-failure');
  expect(serializedArtifact).not.toContain('DEMO_MODE');
  expect(serializedArtifact).not.toContain(observationIds.runId);
  expect(serializedArtifact).not.toContain(observationIds.userId);
  expect(serializedArtifact).not.toContain(replayIds.runId);
  expect(serializedArtifact).not.toContain(replayIds.userId);
  expect(serializedArtifact).not.toMatch(
    /\b(?:promise|contract|verification)\s+(?:passes|passed|is verified|is satisfied|was kept|is kept)\b/i,
  );

  const artifactPath = testInfo.outputPath(
    'promiseproof-offline-investigation.json',
  );
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  await testInfo.attach('promiseproof-offline-investigation.json', {
    path: artifactPath,
    contentType: 'application/json',
  });
});
