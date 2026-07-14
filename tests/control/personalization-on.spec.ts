import { expect, test } from '@playwright/test';

import { formatViolations } from '../../src/shared/evaluator.js';
import { runPromiseScenario } from '../support/scenario.js';

test('ON sends expected activity through the real service and serves a behavioral feed', async ({
  page,
  request,
}, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'on', {
    runId: 'control-on-001',
    userId: 'demo-user-control-on',
  });

  expect(result.browserErrors).toEqual([]);
  expect(result.evidence.request.activityPayloads).toHaveLength(1);
  expect(result.evidence.backend.activityReceipts).toHaveLength(1);
  expect(result.networkActivityResponses).toHaveLength(1);
  expect(result.evidence.backend.activityReceipts[0]?.payload).toEqual(
    result.evidence.request.activityPayloads[0],
  );
  expect(result.evidence.recommendation.source).toBe('behavioral');
  expect(result.evidence.recommendation.itemIds.length).toBeGreaterThan(0);
  expect(result.evidence.ui.preference).toBe('on');
  expect(result.evidence.ui.toggleChecked).toBe(true);
  expect(result.evidence.storage.preference).toBe('on');
  expect(result.evidence.backend.preference).toBe('on');
  await expect(page.getByTestId('sync-status')).toHaveAttribute(
    'data-state',
    'synced',
  );
  expect(result.evidence.backend.recommendationReceipts).toHaveLength(1);
  expect(
    result.renderedRecommendations.every(
      (item) =>
        item.visible &&
        item.titleVisible &&
        item.descriptionVisible &&
        item.title.length > 0 &&
        item.description.length > 0,
    ),
  ).toBe(true);
  expect(result.evidence.backend.recommendationReceipts[0]).toMatchObject({
    source: 'behavioral',
    userId: result.evidence.userId,
    items: result.evidence.recommendation.itemIds.map((id) => ({ id })),
  });
  expect(result.evaluation.violations, formatViolations(result.evaluation)).toEqual(
    [],
  );
  expect(result.evaluation.verdict).toBe('pass');
});
