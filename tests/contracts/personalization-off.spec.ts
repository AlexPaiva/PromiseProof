import { expect, test } from '@playwright/test';

import { formatViolations } from '../../src/shared/evaluator.js';
import { runPromiseScenario } from '../support/scenario.js';

test('OFF satisfies every canonical personalization clause', async ({
  page,
  request,
}, testInfo) => {
  const result = await runPromiseScenario(page, request, testInfo, 'off', {
    runId: 'contract-off-001',
    userId: 'demo-user-contract-off',
  });

  expect(result.browserErrors).toEqual([]);

  // This remains an uncompromised promise assertion under every fixture. Seeded
  // defects must surface as different evidence without changing this threshold.
  expect(result.evaluation.violations, formatViolations(result.evaluation)).toEqual(
    [],
  );
});
