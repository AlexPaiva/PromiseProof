import { expect, test } from '@playwright/test';

import {
  DIAGNOSTIC_REPLAYS,
  selectDiagnosticReplay,
} from '../../src/shared/diagnostics.js';
import { runStartupOrderReplay } from '../support/diagnostic-replays.js';

test('detector isolates the seeded OFF initialization race without weakening other clauses', async ({
  page,
  request,
}, testInfo) => {
  const replay = await runStartupOrderReplay(page, request, testInfo, {
    runId: 'observation-001',
    userId: 'synthetic-subject-001',
  });
  const result = replay.scenario;

  expect(result.browserErrors).toEqual([]);
  expect(result.evidence.request.activityPayloads).toHaveLength(1);
  expect(result.evidence.backend.activityReceipts).toHaveLength(1);
  expect(result.networkActivityResponses).toHaveLength(1);
  expect(result.evidence.request.preferenceUpdates).toEqual([
    {
      targetUserId: result.evidence.userId,
      payload: { preference: 'off', runId: result.evidence.runId },
    },
  ]);
  expect(result.evidence.response.preferenceUpdates).toHaveLength(1);
  expect(result.evidence.backend.preferenceReceipts).toHaveLength(1);
  expect(result.evidence.response.preferenceUpdates[0]?.receipt).toEqual(
    result.evidence.backend.preferenceReceipts[0],
  );
  expect(result.evidence.backend.activityReceipts[0]?.payload).toEqual(
    result.evidence.request.activityPayloads[0],
  );
  expect(
    result.evidence.timestamps.clientTimeline.map((entry) => entry.event),
  ).toEqual([
    'collector_started',
    'activity_dispatched',
    'activity_received',
    'preference_hydration_started',
    'preference_hydration_completed',
    'recommendation_rendered',
  ]);
  expect(
    result.evidence.timestamps.clientTimeline.find(
      (entry) => entry.event === 'preference_hydration_completed',
    )?.detail,
  ).toMatchObject({ preference: 'off' });
  expect(result.evaluation.violations.map((violation) => violation.code)).toEqual([
    'PP_IDENTIFIABLE_EVENT_LEAK',
  ]);
  expect(
    result.evaluation.clauses.find(
      (clause) => clause.id === 'contextual_feed_functional',
    )?.passed,
  ).toBe(true);
  expect(
    result.evaluation.clauses.find(
      (clause) => clause.id === 'preference_survives_reload',
    )?.passed,
  ).toBe(true);
  expect(result.evidence.recommendation.source).toBe('contextual');
  expect(result.evidence.recommendation.itemIds.length).toBeGreaterThan(0);
  expect(result.evidence.backend.recommendationReceipts).toHaveLength(2);
  expect(result.evidence.backend.recommendationReceipts.at(-1)).toMatchObject({
    source: 'contextual',
    items: result.evidence.recommendation.itemIds.map((id) => ({ id })),
  });
  expect(result.evidence.storage.preference).toBe('off');
  expect(result.evidence.ui.toggleChecked).toBe(false);
  expect(result.evidence.backend.preference).toBe('off');
  expect(result.displayedBackendPreference).toBe('off');
  await expect(page.getByTestId('sync-status')).toHaveAttribute(
    'data-state',
    'synced',
  );
  expect(result.evidence.journey.reloadObserved).toBe(true);
  expect(replay.report.collectorBeforeHydration).toBe(true);
  expect(replay.report.activityBeforePreferenceRead).toBe(true);
  expect(replay.report.networkEvents).toContain('activity_post');
  await expect(page.getByTestId('activity-receipt-count')).toHaveText('1');
  expect(selectDiagnosticReplay(result.evaluation)).toBe(
    DIAGNOSTIC_REPLAYS.inspectStartupOrder.id,
  );
  expect(JSON.stringify(result.evidence)).not.toContain('initialization-race');
  expect(JSON.stringify(result.evidence)).not.toContain('propagation-failure');
  expect(result.backendPreferenceState.updatedAt).not.toBeNull();
  expect(Date.parse(result.backendPreferenceState.updatedAt ?? '')).toBeLessThanOrEqual(
    Date.parse(result.evidence.backend.activityReceipts[0]?.receivedAt ?? ''),
  );
  expect(result.evaluation.verdict).toBe('fail');
});
