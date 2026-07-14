import { expect, test } from '@playwright/test';

import {
  runManualJourneyWithoutReset,
  runManualRetakeCycle,
} from '../support/manual-journey.js';

test('manual OFF journey displays only post-OFF activity', async ({
  page,
  request,
}) => {
  const ids = {
    runId: 'manual-observation-001',
    userId: 'synthetic-manual-001',
  };
  const result = await runManualJourneyWithoutReset(page, request, ids);

  expect(result).toEqual({
    totalActivityReceipts: 2,
    displayedActivityReceipts: 1,
    receiptLabel: 'ACTIVITY AFTER OFF',
    backendPreference: 'off',
    agreement: 'match',
    status: 'synced',
    browserErrors: [],
  });

  await expect(runManualRetakeCycle(page, request, ids)).resolves.toEqual({
    totalActivityReceipts: 4,
    displayedActivityReceipts: 1,
    receiptLabel: 'ACTIVITY AFTER OFF',
  });
});
