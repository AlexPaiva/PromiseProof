import { expect, test } from '@playwright/test';

const RUN_ID = 'health-001';
const USER_ID = 'demo-user-health';

test('API and synthetic recommendation app are healthy without console errors', async ({
  page,
  request,
}) => {
  const browserErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });

  const healthResponse = await request.get('/api/health');
  expect(healthResponse.status()).toBe(200);
  await expect(healthResponse.json()).resolves.toEqual({
    ok: true,
    demoMode: 'initialization-race',
  });

  const seedResponse = await request.put(`/api/preferences/${USER_ID}`, {
    data: { preference: 'on', runId: RUN_ID },
  });
  expect(seedResponse.ok()).toBe(true);
  const clearResponse = await request.delete(`/api/evidence/${RUN_ID}`);
  expect(clearResponse.ok()).toBe(true);

  const response = await page.goto(
    `/?runId=${encodeURIComponent(RUN_ID)}&userId=${encodeURIComponent(USER_ID)}`,
  );
  expect(response?.ok()).toBe(true);

  await expect(page.getByTestId('app-root')).toHaveAttribute('data-ready', 'true');
  const toggle = page.getByTestId('personalization-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveRole('switch');
  await expect(toggle).toHaveAccessibleName('Activity-based personalization');
  await expect(page.getByTestId('recommendation-items')).toBeVisible();
  await expect(page.getByTestId('recommendation-item')).toHaveCount(3);
  expect(browserErrors).toEqual([]);
});
