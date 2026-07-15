import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, test } from '@playwright/test';

import { createOpenAIProviderFromEnvironment } from '../../src/investigation/openai-provider.js';
import { runInvestigation } from '../../src/investigation/runner.js';
import { selectDiagnosticReplay } from '../../src/shared/diagnostics.js';
import { createInvestigationReplayExecutors } from '../support/investigation-replays.js';
import { runPromiseScenario } from '../support/scenario.js';

test('GPT-5.6 performs one bounded evidence-led investigation', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const provider = createOpenAIProviderFromEnvironment();
  const observation = await runPromiseScenario(
    page,
    request,
    testInfo,
    'off',
    {
      runId: 'live-observation-001',
      userId: 'synthetic-subject-101',
    },
  );
  expect(observation.browserErrors).toEqual([]);
  const expectedReplay = selectDiagnosticReplay(observation.evaluation);
  expect(expectedReplay).not.toBeNull();

  const artifact = await runInvestigation({
    evidence: observation.evidence,
    provider,
    replayExecutors: createInvestigationReplayExecutors(
      page,
      request,
      testInfo,
      {
        runId: 'live-diagnostic-001',
        userId: 'synthetic-subject-102',
      },
    ),
  });

  const artifactPath = testInfo.outputPath(
    'promiseproof-live-investigation.json',
  );
  await mkdir(dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  await testInfo.attach('promiseproof-live-investigation.json', {
    path: artifactPath,
    contentType: 'application/json',
  });

  expect(artifact.status).toBe('investigation_completed');
  expect(artifact.provider.kind).toBe('openai');
  expect(artifact.provider.requestedModel).toBe('gpt-5.6');
  expect(artifact.provider.responses).toHaveLength(2);
  expect(
    artifact.provider.responses.every(
      (response) =>
        response.responseId.length > 0 &&
        (response.model === 'gpt-5.6' || response.model === 'gpt-5.6-sol') &&
        Number.isFinite(response.latencyMs) &&
        response.latencyMs >= 0,
    ),
  ).toBe(true);
  expect(artifact.bounds).toMatchObject({
    maxProviderCalls: 2,
    providerCallsUsed: 2,
    maxReplayExecutions: 1,
    replayExecutionsUsed: 1,
  });
  expect(artifact.toolValidation.accepted).toBe(true);
  expect(artifact.initialOutput?.replayId).toBe(expectedReplay);
  expect(artifact.replay?.replayId).toBe(expectedReplay);
  expect(artifact.finalOutput?.replayPerformed).toBe(expectedReplay);
  expect(artifact.finalOutput?.limitationCodes).toEqual([
    'single_replay_scope',
    'synthetic_evidence_scope',
    'diagnostic_not_verdict',
  ]);

  const replayReferenceIds = new Set(
    artifact.replay?.evidenceReferences.map((reference) => reference.id) ?? [],
  );
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

  const serializedArtifact = JSON.stringify(artifact);
  expect(serializedArtifact).not.toContain('OPENAI_API_KEY');
  expect(serializedArtifact).not.toMatch(
    /\b(?:promise|contract|verification)\s+(?:passes|passed|is verified|is satisfied|was kept|is kept)\b/i,
  );
  expect(serializedArtifact).not.toMatch(
    /\b(?:compliant|non-compliant|noncompliant|repair succeeded|fixed|approved)\b/i,
  );

  console.log(
    JSON.stringify(
      {
        investigationId: artifact.investigationId,
        dossierSha256: artifact.dossierSha256,
        requestedModel: artifact.provider.requestedModel,
        responses: artifact.provider.responses.map((response) => ({
          phase: response.phase,
          responseId: response.responseId,
          returnedModel: response.model,
          latencyMs: response.latencyMs,
          usage: response.usage,
          outputItems: response.outputItems,
          refusalPresent: response.refusalPresent,
          incompleteReason: response.incompleteReason,
          errorPresent: response.errorPresent,
        })),
        initialHypotheses: artifact.initialOutput?.hypotheses,
        requestedReplay: artifact.initialOutput?.replayId,
        replayEvidence: artifact.replay,
        finalHypotheses: artifact.finalOutput?.hypotheses,
        mostLikelyHypothesisId:
          artifact.finalOutput?.mostLikelyHypothesisId,
        conclusionEvidenceReferences:
          artifact.finalOutput?.conclusionEvidenceReferences,
        limitationCodes: artifact.finalOutput?.limitationCodes,
        bounds: artifact.bounds,
      },
      null,
      2,
    ),
  );
});
