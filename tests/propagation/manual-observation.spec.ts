import { expect, test } from '@playwright/test';

import {
  runManualJourneyWithoutReset,
  runManualRetakeCycle,
} from '../support/manual-journey.js';

test('manual OFF journey displays zero post-OFF activity and the state mismatch', async ({
  page,
  request,
}) => {
  const ids = {
    runId: 'manual-observation-001',
    userId: 'synthetic-manual-001',
  };
  const result = await runManualJourneyWithoutReset(page, request, ids);

  expect(result).toEqual({
    totalActivityReceipts: 1,
    displayedActivityReceipts: 0,
    receiptLabel: 'ACTIVITY AFTER OFF',
    backendPreference: 'on',
    agreement: 'mismatch',
    status: 'error',
    browserErrors: [],
  });

  await expect(runManualRetakeCycle(page, request, ids)).resolves.toEqual({
    totalActivityReceipts: 2,
    displayedActivityReceipts: 0,
    receiptLabel: 'ACTIVITY AFTER OFF',
  });
});
