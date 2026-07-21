import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const mode = process.env.PROMISEPROOF_EQUIVALENCE_MODE;
if (mode !== "initialization-race" && mode !== "propagation-failure") {
  throw new Error(
    "PROMISEPROOF_EQUIVALENCE_MODE must select a registered demo mode.",
  );
}

const baseURL = process.env.PROMISEPROOF_BASE_URL ?? "http://127.0.0.1:4173";
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  testDir: ".",
  testMatch: "pipeline-equivalence.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  projects: [{ name: mode }],
  outputDir: fileURLToPath(
    new URL(`../../test-results/external-equivalence-${mode}`, import.meta.url),
  ),
  expect: { timeout: 5_000 },
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command:
      mode === "initialization-race"
        ? "npm run dev:test:race"
        : "npm run dev:test:propagation",
    cwd: projectRoot,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
