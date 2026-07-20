import assert from "node:assert/strict";
import test from "node:test";

import { checkGate, checkSingle } from "../../src/verify/check.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
} from "../../src/verify/examples.js";
import { createGateReport, createVerifyReport } from "../../src/verify/report.js";
import { runGate, verifyBundle } from "../../src/verify/verify.js";

// A genuine report is one produced by the real pipeline for the given evidence.
async function genuineSingle(bundle: unknown): Promise<unknown> {
  return createVerifyReport(verifyBundle(bundle));
}
async function genuineGate(off: unknown, on: unknown): Promise<unknown> {
  return createGateReport(runGate(off, on));
}
// Deep clone so a mutation never touches the shared example or the source report.
function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

test("a genuine report reproduces from its own evidence", async () => {
  const report = await genuineSingle(passingOffExample);
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "BOUND_AND_REPRODUCED",
  );
});

test("a reformatted/round-tripped report still reproduces", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "BOUND_AND_REPRODUCED",
  );
});

test("a report checked against different evidence does not reproduce", async () => {
  const report = await genuineSingle(passingOffExample);
  assert.equal(
    (await checkSingle(report, passingOnExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a fabricated PASS over broken evidence is caught (hashes alone would miss it)", async () => {
  // Same correct evidence digest and evaluator fingerprint, but an invented verdict.
  const report = clone(await genuineSingle(brokenOffExample));
  report.outcome = "PASS";
  report.canonicalVerdict = "pass";
  report.violations = [];
  assert.equal(
    (await checkSingle(report, brokenOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a tampered evidence digest is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.inputBinding.sha256 = "0".repeat(64);
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a tampered evaluator fingerprint is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.authority.evaluatorSourceSha256 = "0".repeat(64);
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("an altered non-attestation disclosure is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.authority.collectionAttested = true;
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a removed violation is caught", async () => {
  const report = clone(await genuineSingle(brokenOffExample));
  report.violations = [];
  assert.equal(
    (await checkSingle(report, brokenOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("an added violation is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.violations = [
    {
      code: "PP_IDENTIFIABLE_EVENT_LEAK",
      clause: "no_identifiable_activity",
      message: "fabricated",
    },
  ];
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a changed clause observed value is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.clauses[0].observed = "tampered observation";
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a reordered clauses array is caught", async () => {
  const report = clone(await genuineSingle(passingOffExample));
  report.clauses.reverse();
  assert.equal(
    (await checkSingle(report, passingOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("a document that is not a v2 report is INVALID_REPORT_OR_EVIDENCE", async () => {
  assert.equal(
    (await checkSingle({ hello: "world" }, passingOffExample)).status,
    "INVALID_REPORT_OR_EVIDENCE",
  );
});

test("single and gate checks reject the other report kind", async () => {
  const single = await genuineSingle(passingOffExample);
  const gate = await genuineGate(passingOffExample, passingOnExample);

  assert.equal(
    (await checkSingle(gate, passingOffExample)).status,
    "INVALID_REPORT_OR_EVIDENCE",
  );
  assert.equal(
    (await checkGate(single, passingOffExample, passingOnExample)).status,
    "INVALID_REPORT_OR_EVIDENCE",
  );
});

test("strict report validation rejects missing, malformed, and unknown fields", async () => {
  const genuine = clone(await genuineSingle(brokenOffExample));
  const cases: unknown[] = [];

  const missingAuthority = clone(genuine);
  delete missingAuthority.authority;
  cases.push(missingAuthority);

  const malformedClause = clone(genuine);
  malformedClause.clauses[0].passed = "yes";
  cases.push(malformedClause);

  const malformedViolation = clone(genuine);
  malformedViolation.violations[0].code = "PP_NOT_A_REAL_VIOLATION";
  cases.push(malformedViolation);

  const unknownField = clone(genuine);
  unknownField.unexpected = true;
  cases.push(unknownField);

  const wrongOutcome = clone(genuine);
  wrongOutcome.outcome = "INCONCLUSIVE";
  cases.push(wrongOutcome);

  const invalidDigest = clone(genuine);
  invalidDigest.inputBinding.sha256 = "not-a-sha256";
  cases.push(invalidDigest);

  const wrongVersion = clone(genuine);
  wrongVersion.schemaVersion = "1";
  cases.push(wrongVersion);

  for (const report of cases) {
    assert.equal(
      (await checkSingle(report, brokenOffExample)).status,
      "INVALID_REPORT_OR_EVIDENCE",
    );
  }
});

test("valid-shaped semantic forgeries remain STALE_OR_MISMATCH", async () => {
  const report = clone(await genuineSingle(brokenOffExample));
  report.outcome = "PASS";
  report.canonicalVerdict = "pass";
  report.authority.evaluatorSourceSha256 = "0".repeat(64);
  report.authority.collectionAttested = true;

  assert.equal(
    (await checkSingle(report, brokenOffExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("invalid evidence is INVALID_REPORT_OR_EVIDENCE", async () => {
  const report = await genuineSingle(passingOffExample);
  assert.equal(
    (await checkSingle(report, { not: "a bundle" })).status,
    "INVALID_REPORT_OR_EVIDENCE",
  );
});

test("a genuine gate report reproduces", async () => {
  const report = await genuineGate(passingOffExample, passingOnExample);
  assert.equal(
    (await checkGate(report, passingOffExample, passingOnExample)).status,
    "BOUND_AND_REPRODUCED",
  );
});

test("a gate report checked against a changed side does not reproduce", async () => {
  const report = await genuineGate(passingOffExample, passingOnExample);
  assert.equal(
    (await checkGate(report, brokenOffExample, passingOnExample)).status,
    "STALE_OR_MISMATCH",
  );
});

test("gate OFF and ON evidence digests are distinct", async () => {
  const report = clone(await genuineGate(passingOffExample, passingOnExample));
  assert.notEqual(report.inputBindings.off.sha256, report.inputBindings.on.sha256);
});
