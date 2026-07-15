import { fileURLToPath } from 'node:url';

import { defineConfig } from '@playwright/test';

const baseURL = process.env.PROMISEPROOF_BASE_URL ?? 'http://127.0.0.1:4173';
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

if (process.env.OPENAI_API_KEY?.trim().length === 0 || process.env.OPENAI_API_KEY === undefined) {
  throw new Error(
    'OPENAI_API_KEY is required for the explicit live investigation command.',
  );
}

export default defineConfig({
  testDir: '.',
  testMatch: 'live.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  preserveOutput: 'always',
  reporter: [['list']],
  outputDir: fileURLToPath(
    new URL(
      '../../test-results/investigation-live-propagation',
      import.meta.url,
    ),
  ),
  timeout: 240_000,
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
