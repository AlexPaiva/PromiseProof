import { expect, test } from '@playwright/test';

import { formatViolations } from '../../src/shared/evaluator.js';
import { runPromiseScenario } from '../support/scenario.js';

test('OFF keeps identifiable activity out of the recommendation service', async ({
  page,
  request,
}, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'contract-off-001',
    userId: 'demo-user-contract-off',
  });

  expect(result.browserErrors).toEqual([]);

  // This is intentionally a genuine promise assertion. The seeded race makes it
  // exit non-zero with PP_IDENTIFIABLE_EVENT_LEAK until a later repair milestone.
  expect(result.evaluation.violations, formatViolations(result.evaluation)).toEqual(
    [],
  );
});
