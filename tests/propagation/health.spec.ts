import { expect, test } from '@playwright/test';

test('operator health confirms the alternate fixture without entering promise evidence', async ({
  request,
}) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    demoMode: 'propagation-failure',
  });
});
