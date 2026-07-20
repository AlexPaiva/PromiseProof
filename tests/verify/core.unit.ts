import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evaluatePromise } from "../../src/shared/evaluator.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
  producerTemplate,
  scaffoldReadme,
} from "../../src/verify/examples.js";
import {
  createGateReport,
  createVerifyReport,
  serializeGateReportMarkdown,
  serializeReportJson,
  serializeVerifyReportMarkdown,
} from "../../src/verify/report.js";
import {
  externalBundleJsonSchema,
  MAX_COLLECTION_ITEMS,
} from "../../src/verify/schema.js";
import {
  runGate,
  verifyBundle,
} from "../../src/verify/verify.js";

const projectRoot = process.cwd();

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("broken OFF maps the unchanged canonical failure to BROKEN_PROMISE", () => {
  const result = verifyBundle(brokenOffExample);

  assert.equal(result.outcome, "BROKEN_PROMISE");
  assert.equal(result.evaluation?.verdict, "fail");
  assert.deepEqual(
    result.evaluation?.violations.map((violation) => violation.code),
    ["PP_IDENTIFIABLE_EVENT_LEAK"],
  );
});

test("passing OFF and passing ON map canonical passes to PASS", () => {
  const off = verifyBundle(passingOffExample);
  const on = verifyBundle(passingOnExample);

  assert.equal(off.outcome, "PASS");
  assert.equal(off.evaluation?.verdict, "pass");
  assert.equal(on.outcome, "PASS");
  assert.equal(on.evaluation?.verdict, "pass");
});

test("broken ON maps the unchanged canonical failure to BROKEN_PROMISE", () => {
  const brokenOn = clone(passingOnExample);
  brokenOn.evidence.backend.activityReceipts = [];

  const result = verifyBundle(brokenOn);
  assert.equal(result.outcome, "BROKEN_PROMISE");
  assert.deepEqual(
    result.evaluation?.violations.map((violation) => violation.code),
    ["PP_EXPECTED_ACTIVITY_MISSING"],
  );
});

test("gate requires passing OFF and ON evidence", () => {
  const passing = runGate(passingOffExample, passingOnExample);
  const broken = runGate(brokenOffExample, passingOnExample);

  assert.equal(passing.outcome, "PASS");
  assert.equal(broken.outcome, "BROKEN_PROMISE");
  assert.equal(broken.off.outcome, "BROKEN_PROMISE");
  assert.equal(broken.on.outcome, "PASS");
});

test("gate rejects evidence supplied in the wrong scenario slot", () => {
  const result = runGate(passingOnExample, passingOffExample);

  assert.equal(result.outcome, "INVALID_EVIDENCE");
  assert.deepEqual(result.issues, [
    "--off bundle must contain OFF-scenario evidence",
    "--on bundle must contain ON-scenario evidence",
  ]);
  assert.equal(result.off.evaluation?.verdict, "pass");
  assert.equal(result.on.evaluation?.verdict, "pass");
});

test("strict validation rejects missing fields, unknown fields, and unsupported envelope values", () => {
  const missing = clone(passingOffExample) as Record<string, unknown>;
  delete (missing.evidence as Record<string, unknown>).journey;

  const unknown = clone(passingOffExample) as Record<string, unknown>;
  (unknown.evidence as Record<string, unknown>).unexpected = true;
  const nestedUnknown = clone(passingOffExample);
  Object.assign(nestedUnknown.evidence.ui, { unexpected: true });

  const version = {
    ...clone(passingOffExample),
    schemaVersion: "2",
  };
  const family = {
    ...clone(passingOffExample),
    contractFamily: "generic-consent/v1",
  };

  for (const candidate of [
    missing,
    unknown,
    nestedUnknown,
    version,
    family,
  ]) {
    const result = verifyBundle(candidate);
    assert.equal(result.outcome, "INVALID_EVIDENCE");
    assert.equal(result.evaluation, null);
    assert.ok(result.issues.length > 0);
  }
});

test("validation rejects malformed identifiers and timestamps without coercion", () => {
  const identifier = clone(passingOffExample);
  identifier.evidence.runId = "   ";
  const timestamp = clone(passingOffExample);
  timestamp.evidence.timestamps.preferenceReceivedAt = ["not-a-timestamp"];

  assert.equal(verifyBundle(identifier).outcome, "INVALID_EVIDENCE");
  assert.equal(verifyBundle(timestamp).outcome, "INVALID_EVIDENCE");
  assert.equal(identifier.evidence.runId, "   ");
});

test("bounded collections are rejected before canonical evaluation", () => {
  const oversized = clone(passingOffExample);
  oversized.evidence.timestamps.activityReceivedAt = Array.from(
    { length: MAX_COLLECTION_ITEMS + 1 },
    () => "2026-01-15T12:00:01.000Z",
  );

  const result = verifyBundle(oversized);
  assert.equal(result.outcome, "INVALID_EVIDENCE");
  assert.equal(result.evaluation, null);
  assert.match(result.issues.join("\n"), /Too big/);
});

test("valid evidence reaches the unchanged evaluator only after validation", () => {
  const invalid = {
    schemaVersion: "1",
    contractFamily: "activity-personalization/v1",
    evidence: {},
  };
  const rejected = verifyBundle(invalid);
  const accepted = verifyBundle(passingOffExample);

  assert.equal(rejected.outcome, "INVALID_EVIDENCE");
  assert.equal(rejected.evaluation, null);
  assert.deepEqual(
    accepted.evaluation,
    evaluatePromise(passingOffExample.evidence),
  );
});

test("single reports are deterministic with canonical clause and violation ordering", () => {
  const broken = verifyBundle(brokenOffExample);
  const first = createVerifyReport(broken);
  const second = createVerifyReport(verifyBundle(clone(brokenOffExample)));

  assert.deepEqual(
    first.clauses.map((clause) => clause.id),
    [
      "no_identifiable_activity",
      "contextual_feed_functional",
      "preference_survives_reload",
    ],
  );
  assert.deepEqual(
    first.violations.map((violation) => violation.code),
    ["PP_IDENTIFIABLE_EVENT_LEAK"],
  );
  assert.equal(serializeReportJson(first), serializeReportJson(second));
  assert.equal(
    serializeVerifyReportMarkdown(first),
    serializeVerifyReportMarkdown(second),
  );
});

test("gate reports preserve separate deterministic OFF and ON evaluations", () => {
  const first = createGateReport(
    runGate(passingOffExample, passingOnExample),
  );
  const second = createGateReport(
    runGate(clone(passingOffExample), clone(passingOnExample)),
  );

  assert.deepEqual(
    first.evaluations.off.clauses.map((clause) => clause.id),
    [
      "no_identifiable_activity",
      "contextual_feed_functional",
      "preference_survives_reload",
    ],
  );
  assert.deepEqual(
    first.evaluations.on.clauses.map((clause) => clause.id),
    ["expected_activity_received", "behavioral_feed_functional"],
  );
  assert.equal(serializeReportJson(first), serializeReportJson(second));
  assert.equal(
    serializeGateReportMarkdown(first),
    serializeGateReportMarkdown(second),
  );
});

test("reports disclose external evidence authority and contain no machine metadata", () => {
  const report = serializeReportJson(
    createVerifyReport(verifyBundle(passingOffExample)),
  );
  const markdown = serializeVerifyReportMarkdown(
    createVerifyReport(verifyBundle(passingOffExample)),
  );

  assert.match(report, /"evidenceSource": "externally-supplied"/);
  assert.match(report, /"collectionAttested": false/);
  assert.match(
    report,
    /"evaluation": "deterministic-promiseproof-evaluator"/,
  );
  assert.match(markdown, /Evidence source: externally supplied/);
  assert.match(
    markdown,
    /Collection integrity: not attested by PromiseProof/,
  );
  assert.match(
    markdown,
    /Evaluation authority: deterministic PromiseProof evaluator/,
  );
  assert.doesNotMatch(report, /generatedAt|hostname|username|[A-Z]:\\/i);
});

test("invalid evidence cannot be rendered as a canonical report", () => {
  const invalid = verifyBundle({ malformed: true });

  assert.equal(invalid.outcome, "INVALID_EVIDENCE");
  assert.throws(
    () => createVerifyReport(invalid),
    /Invalid evidence cannot be rendered as a product verdict/,
  );
});

test("committed JSON Schema is generated byte-for-byte from the runtime Zod schema", async () => {
  const committed = await readFile(
    path.join(
      projectRoot,
      "artifacts",
      "verify",
      "activity-personalization.v1.schema.json",
    ),
    "utf8",
  );
  const generated = `${JSON.stringify(externalBundleJsonSchema(), null, 2)}\n`;

  assert.equal(committed, generated);
});

test("committed scaffold text artifacts match the runtime scaffold exactly", async () => {
  const artifactRoot = path.join(projectRoot, "artifacts", "verify");

  assert.equal(
    await readFile(path.join(artifactRoot, "producer-template.mjs"), "utf8"),
    producerTemplate,
  );
  assert.equal(
    await readFile(path.join(artifactRoot, "README.md"), "utf8"),
    scaffoldReadme,
  );
});

test("Article Atlas examples are independent and limited to the supported family", () => {
  const serialized = JSON.stringify([
    brokenOffExample,
    passingOffExample,
    passingOnExample,
  ]);

  assert.match(serialized, /article-atlas/i);
  assert.doesNotMatch(
    serialized,
    /signal shelf|initialization-race|propagation-failure|fixture|src\//i,
  );
  assert.equal(brokenOffExample.contractFamily, "activity-personalization/v1");
  assert.equal(passingOffExample.contractFamily, "activity-personalization/v1");
  assert.equal(passingOnExample.contractFamily, "activity-personalization/v1");
});

test("external verifier modules have no forbidden implementation imports", async () => {
  const verifyDirectory = path.join(projectRoot, "src", "verify");
  const filenames = [
    "cli.ts",
    "examples.ts",
    "outcome.ts",
    "report.ts",
    "schema.ts",
    "verify.ts",
  ];
  const forbidden =
    /from\s+["'][^"']*(client|server|investigation|repair|judge|tests|docs\/evidence|artifacts|@openai|openai|codex|playwright)[^"']*["']/;

  for (const filename of filenames) {
    const source = await readFile(path.join(verifyDirectory, filename), "utf8");
    assert.doesNotMatch(source, forbidden, filename);
  }

  const verifierSource = await readFile(
    path.join(verifyDirectory, "verify.ts"),
    "utf8",
  );
  assert.match(
    verifierSource,
    /import \{ evaluatePromise \} from "\.\.\/shared\/evaluator\.js"/,
  );
  assert.ok(
    verifierSource.indexOf("if (!parsed.success)") <
      verifierSource.indexOf("evaluatePromise(evidence)"),
  );
});
