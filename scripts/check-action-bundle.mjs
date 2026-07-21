// Proves the committed Action bundle is deterministic and fresh.
// Builds src/action/index.ts twice into temporary files with the same options
// as `npm run build:action`, requires the two builds to be byte-identical, and
// requires them to match the committed .github/actions/verify/dist/index.js.
// A consumer runs the committed bundle, so a stale bundle is a correctness bug.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMITTED = ".github/actions/verify/dist/index.js";
const ENTRY = "src/action/index.ts";
const ESBUILD_BIN = "node_modules/esbuild/bin/esbuild";

function build(outfile) {
  execFileSync(
    process.execPath,
    [
      ESBUILD_BIN,
      ENTRY,
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      `--outfile=${outfile}`,
    ],
    { stdio: "pipe" },
  );
  return readFileSync(outfile);
}

const dir = mkdtempSync(join(tmpdir(), "pp-action-bundle-"));
try {
  const first = build(join(dir, "first.js"));
  const second = build(join(dir, "second.js"));
  if (!first.equals(second)) {
    console.error("Action bundle is not deterministic: two builds differ.");
    process.exit(1);
  }
  const committed = readFileSync(COMMITTED);
  if (!committed.equals(first)) {
    console.error(
      `Committed ${COMMITTED} is stale or differs from source. Run: npm run build:action`,
    );
    process.exit(1);
  }
  console.log(`Action bundle is fresh and deterministic (${committed.length} bytes).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
