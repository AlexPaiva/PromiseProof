// Cross-platform assertions for the real-Action consumer smoke job.
// Runs on node built-ins only, after the repository source and node_modules
// have been removed, so it proves the bundled Action needs neither.
// Expectations arrive through environment variables set from step outputs.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const PINNED_EVALUATOR =
  "fca20925861d1de2772ad0297a2465029678c4f34faa7a4755592f37aef9f87f";

const check = process.argv[2];
const env = process.env;
const isHex64 = (value) => /^[0-9a-f]{64}$/.test(value ?? "");

switch (check) {
  case "pass-gate": {
    assert.equal(env.STATUS, "PASS", `status was ${env.STATUS}`);
    assert.ok(existsSync(env.REPORT_JSON ?? ""), "report.json is missing");
    assert.ok(existsSync(env.REPORT_MD ?? ""), "report.md is missing");
    assert.equal(env.EVALUATOR_SHA, PINNED_EVALUATOR, "evaluator fingerprint mismatch");
    assert.ok(isHex64(env.OFF_SHA), "off digest not a sha256");
    assert.ok(isHex64(env.ON_SHA), "on digest not a sha256");
    assert.notEqual(env.OFF_SHA, env.ON_SHA, "off and on digests must differ");
    break;
  }
  case "broken-gate": {
    assert.equal(env.STATUS, "BROKEN_PROMISE", `status was ${env.STATUS}`);
    assert.ok(existsSync(env.REPORT_JSON ?? ""), "broken report.json is missing");
    const report = JSON.parse(readFileSync(env.REPORT_JSON, "utf8"));
    assert.equal(report.outcome, "BROKEN_PROMISE", "report outcome must be BROKEN_PROMISE");
    break;
  }
  case "check-bound": {
    assert.equal(env.STATUS, "BOUND_AND_REPRODUCED", `status was ${env.STATUS}`);
    break;
  }
  case "check-stale": {
    assert.equal(env.STATUS, "STALE_OR_MISMATCH", `status was ${env.STATUS}`);
    break;
  }
  case "invalid": {
    assert.equal(env.STATUS, "INVALID_EVIDENCE", `status was ${env.STATUS}`);
    assert.ok(!existsSync(env.REPORT_JSON ?? "missing"), "no canonical report may exist");
    break;
  }
  default:
    throw new Error(`unknown check: ${check}`);
}

console.log(`consumer assertion passed: ${check}`);
