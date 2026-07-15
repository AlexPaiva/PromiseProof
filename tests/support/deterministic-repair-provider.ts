import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
  RepairProvider,
  RepairProviderInput,
  RepairProviderResult,
} from '../../src/repair/provider.js';

const REGRESSION = `import { expect, test } from '@playwright/test';

import { runPromiseScenario } from '../support/scenario.js';

test('persisted OFF hydrates before startup collection', async ({
  page,
  request,
}, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'regression-off-001',
    userId: 'demo-user-regression-off',
  });
  const events = result.evidence.timestamps.clientTimeline.map(
    (entry) => entry.event,
  );
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
  expect(result.evidence.recommendation.itemIds.length).toBeGreaterThan(0);
  expect(result.evidence.ui.preference).toBe('off');
  expect(result.evidence.storage.preference).toBe('off');
  expect(result.evidence.backend.preference).toBe('off');
});
`;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function repairSource(source: string): string {
  const normalized = source.replaceAll('\r\n', '\n');
  const branchMarker = '    if (demoMode === "initialization-race") {\n';
  const elseMarker = '    } else {';
  const branchIndex = normalized.indexOf(branchMarker);
  const bodyStart = branchIndex + branchMarker.length;
  const elseIndex = normalized.indexOf(elseMarker, bodyStart);
  if (
    branchIndex < 0 ||
    normalized.indexOf(branchMarker, bodyStart) >= 0 ||
    elseIndex < bodyStart
  ) {
    throw new Error(
      'Offline repair fixture could not identify the exact seeded startup-order boundary.',
    );
  }
  const safeBody = [
    '      setStatus("Restoring preference before activity collection…", "working");',
    '      await hydratePreference();',
    '      await runStartupCollector();',
    '',
  ].join('\n');
  return `${normalized.slice(0, bodyStart)}${safeBody}${normalized.slice(elseIndex)}`;
}

export class DeterministicRepairProvider implements RepairProvider {
  async prepareRepair(
    input: RepairProviderInput,
  ): Promise<RepairProviderResult> {
    const started = Date.now();
    const sourcePath = path.join(input.worktreePath, 'src', 'client', 'main.ts');
    const regressionPath = path.join(
      input.worktreePath,
      'tests',
      'regression',
      'initialization-order.spec.ts',
    );
    const source = await readFile(sourcePath, 'utf8');
    await mkdir(path.dirname(regressionPath), { recursive: true });
    await Promise.all([
      writeFile(sourcePath, repairSource(source), 'utf8'),
      writeFile(regressionPath, REGRESSION, { encoding: 'utf8', flag: 'wx' }),
    ]);
    const finalResponse = JSON.stringify({
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
    });
    const completed = Date.now();
    return {
      kind: 'offline-deterministic',
      requestedModel: 'offline-codex-fixture',
      sdkVersion: 'offline-fixture-v1',
      cliVersion: 'offline-fixture-v1',
      threadId: `offline_${randomUUID().replaceAll('-', '')}`,
      turnsUsed: 1,
      summary: JSON.parse(finalResponse) as RepairProviderResult['summary'],
      finalResponseSha256: sha256(finalResponse),
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
      events: {
        eventCount: 5,
        serializedBytesObserved: 512,
        eventTypeCounts: {
          'thread.started': 1,
          'turn.started': 1,
          'item.completed': 2,
          'turn.completed': 1,
        },
        completedItemTypeCounts: { file_change: 1, agent_message: 1 },
        completedCommandCount: 0,
        completedFileChangeCount: 1,
        observedFilePaths: [
          'src/client/main.ts',
          'tests/regression/initialization-order.spec.ts',
        ],
        sanitizedSequenceSha256: sha256('offline-deterministic-sequence'),
      },
      timing: {
        startedAt: new Date(started).toISOString(),
        completedAt: new Date(completed).toISOString(),
        totalMs: completed - started,
      },
      validationCodes: [
        'PP_REPAIR_OFFLINE_PROVIDER_ACCEPTED',
        'PP_REPAIR_OFFLINE_SUMMARY_ACCEPTED',
      ],
    };
  }
}
