import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

// Serves the assembled combined site (dist/site) statically and drives the
// hosted verifier at /verify/. The verifier is a static, self-contained page,
// so it needs no application server — only the built assets.
const PORT = 4188;
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default defineConfig({
  testDir: ".",
  testMatch: /judge-mode\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: BASE,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npm run build:site && node scripts/serve-site.mjs dist/site ${PORT}`,
    cwd: REPO_ROOT,
    url: `${BASE}/verify/`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
