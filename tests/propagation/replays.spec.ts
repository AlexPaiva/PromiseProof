import { expect, test } from '@playwright/test';

import { runPreferenceRoundtripReplay } from '../support/diagnostic-replays.js';

test('preference round-trip replay reports acknowledged OFF and authoritative ON', async ({
  request,
}, testInfo) => {
  const replay = await runPreferenceRoundtripReplay(request, testInfo, {
    runId: 'replay-001',
    userId: 'synthetic-subject-002',
  });

  expect(replay.report).toEqual({
    requested: 'off',
    acknowledged: 'off',
    authoritativeReadback: 'on',
    receiptRecorded: true,
    identityCorrelated: true,
    roundtripConsistent: false,
  });
  expect(replay.ledger.preferenceReceipts).toHaveLength(1);
  expect(replay.ledger.preferenceReceipts[0]).toEqual(replay.write.receipt);
  expect(JSON.stringify(replay)).not.toContain('initialization-race');
  expect(JSON.stringify(replay)).not.toContain('propagation-failure');
});
