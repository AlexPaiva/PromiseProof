import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

export const promiseProofBaseUrl =
  process.env.PROMISEPROOF_BASE_URL ?? 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/contracts/**', '**/propagation/**'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  outputDir: fileURLToPath(
    new URL('./test-results/race-green', import.meta.url),
  ),
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: promiseProofBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:test:race',
    url: `${promiseProofBaseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
