import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { passingOffExample, passingOnExample } from "../../src/verify/examples.js";
import {
  createGateReport,
  serializeGateReportMarkdown,
  serializeReportJson,
} from "../../src/verify/report.js";
import { runGate } from "../../src/verify/verify.js";

const DIR = path.join(process.cwd(), "artifacts", "verify");

// The committed fixture is what the Action check-mode consumer smoke reproduces.
// It must be generated, never hand-authored, so this test regenerates it from
// the shipped examples and requires exact byte equality.
test("the committed passing-gate report fixture regenerates byte-for-byte", async () => {
  const report = await createGateReport(runGate(passingOffExample, passingOnExample));
  const json = serializeReportJson(report);
  const markdown = serializeGateReportMarkdown(report);
  assert.equal(
    json,
    readFileSync(path.join(DIR, "passing-gate.report.json"), "utf8"),
    "passing-gate.report.json is stale; regenerate it from the examples",
  );
  assert.equal(
    markdown,
    readFileSync(path.join(DIR, "passing-gate.report.md"), "utf8"),
    "passing-gate.report.md is stale; regenerate it from the examples",
  );
});
