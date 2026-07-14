import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const baseURL = process.env.PROMISEPROOF_BASE_URL ?? 'http://127.0.0.1:4173';
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: '..',
  testMatch: [
    'propagation/health.spec.ts',
    'propagation/manual-observation.spec.ts',
    'control/personalization-on.spec.ts',
    'propagation/detector.spec.ts',
    'propagation/replays.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  outputDir: fileURLToPath(
    new URL('../../test-results/propagation-green', import.meta.url),
  ),
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:test:propagation',
    cwd: projectRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
