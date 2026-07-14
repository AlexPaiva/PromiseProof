import { expect, test } from '@playwright/test';

import { runPromiseScenario } from '../support/scenario.js';

test('detector isolates the seeded OFF initialization race without weakening other clauses', async ({
  page,
  request,
}, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'detector-off-race-001',
    userId: 'demo-user-detector-off',
  });

  expect(result.browserErrors).toEqual([]);
  expect(result.evidence.request.activityPayloads).toHaveLength(1);
  expect(result.evidence.backend.activityReceipts).toHaveLength(1);
  expect(result.networkActivityResponses).toHaveLength(1);
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
  expect(result.evidence.backend.recommendationReceipts).toHaveLength(1);
  expect(result.evidence.backend.recommendationReceipts[0]).toMatchObject({
    source: 'contextual',
    items: result.evidence.recommendation.itemIds.map((id) => ({ id })),
  });
  expect(result.evidence.storage.preference).toBe('off');
  expect(result.evidence.backend.preference).toBe('off');
  expect(result.backendPreferenceState.updatedAt).not.toBeNull();
  expect(Date.parse(result.backendPreferenceState.updatedAt ?? '')).toBeLessThanOrEqual(
    Date.parse(result.evidence.backend.activityReceipts[0]?.receivedAt ?? ''),
  );
  expect(result.evaluation.verdict).toBe('fail');
});
