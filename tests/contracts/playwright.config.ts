import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const baseURL = process.env.PROMISEPROOF_BASE_URL ?? 'http://127.0.0.1:4173';
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

// This configuration is intentionally separate: the seeded contract is expected
// to fail until the later repair milestone, so it must never contaminate `npm test`.
export default defineConfig({
  testDir: '.',
  testMatch: 'personalization-off.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev:test',
    cwd: projectRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
