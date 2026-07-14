import { expect, test } from '@playwright/test';

import {
  DIAGNOSTIC_REPLAYS,
  selectDiagnosticReplay,
} from '../../src/shared/diagnostics.js';
import { runStartupOrderReplay } from '../support/diagnostic-replays.js';

test('detector isolates an acknowledged OFF write from authoritative backend state', async ({
  page,
  request,
}, testInfo) => {
  const replay = await runStartupOrderReplay(page, request, testInfo, {
    runId: 'observation-001',
    userId: 'synthetic-subject-001',
  });
  const result = replay.scenario;

  expect(result.browserErrors).toEqual([]);
  expect(result.evidence.request.activityPayloads).toEqual([]);
  expect(result.evidence.backend.activityReceipts).toEqual([]);
  expect(result.networkActivityResponses).toEqual([]);
  expect(result.evidence.request.preferenceUpdates).toEqual([
    {
      targetUserId: result.evidence.userId,
      payload: { preference: 'off', runId: result.evidence.runId },
    },
    {
      targetUserId: result.evidence.userId,
      payload: { preference: 'off', runId: result.evidence.runId },
    },
  ]);
  expect(result.evidence.response.preferenceUpdates).toHaveLength(2);
  expect(result.networkPreferenceResponses).toHaveLength(2);
  expect(result.evidence.backend.preferenceReceipts).toHaveLength(2);
  expect(
    result.evidence.response.preferenceUpdates.every(
      (response) =>
        response.preference === 'off' &&
        response.userId === result.evidence.userId &&
        response.receipt.userId === result.evidence.userId &&
        result.evidence.backend.preferenceReceipts.some(
          (receipt) => receipt.receiptId === response.receipt.receiptId,
        ),
    ),
  ).toBe(true);

  expect(result.evidence.timestamps.clientTimeline.map((entry) => entry.event)).toEqual([
    'preference_hydration_started',
    'preference_sync_dispatched',
    'preference_sync_acknowledged',
    'backend_preference_observed',
    'preference_hydration_completed',
    'collector_started',
    'collector_suppressed',
    'recommendation_rendered',
  ]);
  expect(replay.report.collectorBeforeHydration).toBe(false);
  expect(replay.report.activityRequestCount).toBe(0);
  expect(replay.report.activityReceiptCount).toBe(0);
  expect(replay.report.activityBeforePreferenceRead).toBe(false);
  expect(replay.report.networkEvents).not.toContain('activity_post');

  expect(result.evidence.ui.preference).toBe('off');
  expect(result.evidence.ui.toggleChecked).toBe(false);
  expect(result.evidence.storage.preference).toBe('off');
  expect(result.evidence.backend.preference).toBe('on');
  expect(result.displayedBackendPreference).toBe('on');
  expect(result.evidence.journey.reloadObserved).toBe(true);
  await expect(page.getByTestId('preference-agreement')).toHaveAttribute(
    'data-state',
    'mismatch',
  );
  await expect(page.getByTestId('sync-status')).toHaveAttribute(
    'data-state',
    'error',
  );
  await expect(page.getByTestId('sync-status')).toContainText(
    'State mismatch: UI OFF, stored OFF, backend ON.',
  );
  await expect(page.getByTestId('activity-receipt-count')).toHaveText('0');
  expect(result.evidence.recommendation.source).toBe('contextual');
  expect(result.evidence.recommendation.itemIds).toHaveLength(3);
  expect(result.evaluation.violations.map((item) => item.code)).toEqual([
    'PP_PREFERENCE_NOT_PERSISTED',
  ]);
  expect(
    result.evaluation.clauses.find(
      (item) => item.id === 'no_identifiable_activity',
    )?.passed,
  ).toBe(true);
  expect(
    result.evaluation.clauses.find(
      (item) => item.id === 'contextual_feed_functional',
    )?.passed,
  ).toBe(true);
  expect(selectDiagnosticReplay(result.evaluation)).toBe(
    DIAGNOSTIC_REPLAYS.inspectPreferenceRoundtrip.id,
  );
  expect(JSON.stringify(result.evidence)).not.toContain('initialization-race');
  expect(JSON.stringify(result.evidence)).not.toContain('propagation-failure');
});
