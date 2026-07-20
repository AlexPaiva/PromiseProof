import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { evaluatePromise } from "../../src/shared/evaluator.js";
import { adaptExternalEvidence } from "../../src/verify/adapter.js";
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
  type VerifyReport,
} from "../../src/verify/report.js";
import {
  externalBundleJsonSchema,
  MAX_COLLECTION_ITEMS,
  type ExternalBundle,
} from "../../src/verify/schema.js";
import {
  runGate,
  verifierTestHooks,
  verifyBundle,
} from "../../src/verify/verify.js";
import {
  canonicalCases,
  projectCanonicalEvidence,
} from "./canonical-projection.js";

const projectRoot = process.cwd();

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

test("broken OFF, passing OFF, passing ON, and broken ON preserve canonical outcomes", () => {
  const brokenOff = verifyBundle(brokenOffExample);
  const passingOff = verifyBundle(passingOffExample);
  const passingOn = verifyBundle(passingOnExample);
  const brokenOnBundle = clone(passingOnExample);
  brokenOnBundle.evidence.activity.recommendationServiceReceipts = [];
  const brokenOn = verifyBundle(brokenOnBundle);

  assert.equal(brokenOff.outcome, "BROKEN_PROMISE");
  assert.deepEqual(
    brokenOff.evaluation?.violations.map((item) => item.code),
    ["PP_IDENTIFIABLE_EVENT_LEAK"],
  );
  assert.equal(passingOff.outcome, "PASS");
  assert.equal(passingOn.outcome, "PASS");
  assert.equal(brokenOn.outcome, "BROKEN_PROMISE");
  assert.deepEqual(
    brokenOn.evaluation?.violations.map((item) => item.code),
    ["PP_EXPECTED_ACTIVITY_MISSING"],
  );
});

test("gate evaluates exactly twice only after both inputs and slots are valid", () => {
  let calls = 0;
  const result = verifierTestHooks.runGateWithEvaluator(
    passingOffExample,
    passingOnExample,
    (evidence) => {
      calls += 1;
      return evaluatePromise(evidence);
    },
  );

  assert.equal(result.outcome, "PASS");
  assert.equal(calls, 2);
});

test("invalid gates atomically invoke no canonical evaluation", () => {
  const invalidCases: Array<[string, unknown, unknown]> = [
    ["OFF bundle in ON slot", passingOnExample, passingOnExample],
    ["ON bundle in OFF slot", passingOffExample, passingOffExample],
    ["malformed OFF", { malformed: true }, passingOnExample],
    ["malformed ON", passingOffExample, { malformed: true }],
    [
      "unsupported version",
      { ...clone(passingOffExample), schemaVersion: "2" },
      passingOnExample,
    ],
    [
      "unsupported family",
      passingOffExample,
      {
        ...clone(passingOnExample),
        contractFamily: "generic-consent/v1",
      },
    ],
  ];

  for (const [name, off, on] of invalidCases) {
    let calls = 0;
    const result = verifierTestHooks.runGateWithEvaluator(
      off,
      on,
      (evidence) => {
        calls += 1;
        return evaluatePromise(evidence);
      },
    );

    assert.equal(result.outcome, "INVALID_EVIDENCE", name);
    assert.equal(result.off.evaluation, null, name);
    assert.equal(result.on.evaluation, null, name);
    assert.equal(calls, 0, name);
    assert.ok(result.issues.length > 0, name);
    assert.deepEqual([...result.issues], [...result.issues].sort(), name);
    assert.deepEqual(
      [...result.off.issues],
      [...result.off.issues].sort(),
      name,
    );
    assert.deepEqual(
      [...result.on.issues],
      [...result.on.issues].sort(),
      name,
    );
  }
});

test("swapped gate slots remain unevaluated", () => {
  const result = runGate(passingOnExample, passingOffExample);

  assert.equal(result.outcome, "INVALID_EVIDENCE");
  assert.equal(result.off.evaluation, null);
  assert.equal(result.on.evaluation, null);
  assert.deepEqual(result.issues, [
    "--off bundle must contain OFF-scenario evidence",
    "--on bundle must contain ON-scenario evidence",
  ]);
});

test("strict minimal validation rejects missing, unknown, unsupported, and malformed fields", () => {
  const missing = clone(passingOffExample) as Record<string, unknown>;
  delete (missing.evidence as Record<string, unknown>).control;
  const unknown = clone(passingOffExample) as Record<string, unknown>;
  (unknown.evidence as Record<string, unknown>).unexpected = true;
  const nestedUnknown = clone(passingOffExample);
  Object.assign(nestedUnknown.evidence.control, { unexpected: true });
  const version = { ...clone(passingOffExample), schemaVersion: "2" };
  const family = {
    ...clone(passingOffExample),
    contractFamily: "generic-consent/v1",
  };
  const whitespace = clone(passingOffExample);
  whitespace.evidence.subjectId = "   ";
  const timestamp = clone(passingOnExample);
  timestamp.evidence.activity.capturedActivities[0]!.occurredAt =
    "not-a-timestamp";

  for (const candidate of [
    missing,
    unknown,
    nestedUnknown,
    version,
    family,
    whitespace,
    timestamp,
  ]) {
    const result = verifyBundle(candidate);
    assert.equal(result.outcome, "INVALID_EVIDENCE");
    assert.equal(result.evaluation, null);
    assert.ok(result.issues.length > 0);
  }
});

test("ASCII controls and Unicode bidi override/isolate characters are rejected", () => {
  const forbidden = [
    "\u0000",
    "\u0008",
    "\t",
    "\n",
    "\r",
    "\u007f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
  ];

  for (const character of forbidden) {
    const candidate = clone(passingOnExample);
    candidate.evidence.subjectId = `reader${character}name`;
    assert.equal(
      verifyBundle(candidate).outcome,
      "INVALID_EVIDENCE",
      `U+${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
    );
  }
});

test("bounded collections are rejected before canonical evaluation", () => {
  const oversized = clone(passingOffExample);
  oversized.evidence.recommendations.renderedItemIds = Array.from(
    { length: MAX_COLLECTION_ITEMS + 1 },
    (_, index) => `article-${index}`,
  );

  const result = verifyBundle(oversized);
  assert.equal(result.outcome, "INVALID_EVIDENCE");
  assert.equal(result.evaluation, null);
  assert.match(result.issues.join("\n"), /Too big/);
});

test("Markdown encodes HTML, ampersands, backticks, pipes, and backslashes deterministically", () => {
  const adversarial = clone(passingOnExample);
  const subject = "<reader>&`pipe|slash\\";
  adversarial.evidence.subjectId = subject;
  adversarial.evidence.activity.capturedActivities[0]!.subjectId = subject;
  adversarial.evidence.activity.recommendationServiceReceipts[0]!.subjectId =
    subject;
  adversarial.evidence.recommendations.recommendationServiceReceipts[0]!.subjectId =
    subject;

  const first = createVerifyReport(verifyBundle(adversarial));
  const second = createVerifyReport(verifyBundle(clone(adversarial)));
  const markdown = serializeVerifyReportMarkdown(first);

  assert.equal(first.outcome, "PASS");
  assert.equal(markdown, serializeVerifyReportMarkdown(second));
  assert.match(markdown, /&lt;reader&gt;&amp;&#96;pipe\\\|slash\\\\/);
  assert.doesNotMatch(markdown, /<reader>/);
});

test("Markdown converts CR, LF, and CRLF to inert spaces after encoding", () => {
  const report = clone(
    createVerifyReport(verifyBundle(passingOffExample)),
  ) as VerifyReport;
  const mutableClause = report.clauses[0]!;
  Object.assign(mutableClause, {
    expected: "one\r\ntwo\nthree\rfour",
    observed: "<tag>&`|\\",
  });

  const markdown = serializeVerifyReportMarkdown(report);
  assert.match(markdown, /one two three four/);
  assert.match(markdown, /&lt;tag&gt;&amp;&#96;\\\|\\\\/);
  assert.doesNotMatch(markdown, /\r/);
});

test("single and gate reports preserve deterministic canonical ordering", () => {
  const single = createVerifyReport(verifyBundle(brokenOffExample));
  const gate = createGateReport(runGate(passingOffExample, passingOnExample));

  assert.deepEqual(
    single.clauses.map((clause) => clause.id),
    [
      "no_identifiable_activity",
      "contextual_feed_functional",
      "preference_survives_reload",
    ],
  );
  assert.deepEqual(
    gate.evaluations.on.clauses.map((clause) => clause.id),
    ["expected_activity_received", "behavioral_feed_functional"],
  );
  assert.equal(
    serializeReportJson(single),
    serializeReportJson(
      createVerifyReport(verifyBundle(clone(brokenOffExample))),
    ),
  );
  assert.equal(
    serializeGateReportMarkdown(gate),
    serializeGateReportMarkdown(
      createGateReport(
        runGate(clone(passingOffExample), clone(passingOnExample)),
      ),
    ),
  );
});

test("adapter placeholders never enter public reports", () => {
  const json = serializeReportJson(
    createVerifyReport(verifyBundle(passingOffExample)),
  );
  const markdown = serializeVerifyReportMarkdown(
    createVerifyReport(verifyBundle(passingOffExample)),
  );

  for (const forbidden of [
    "promiseproof-external-adapter",
    "2000-01-01T00:00:00.000Z",
    "Not part of externally supplied evidence",
  ]) {
    assert.doesNotMatch(json, new RegExp(forbidden));
    assert.doesNotMatch(markdown, new RegExp(forbidden));
  }
});

test("canonical projection and deterministic adapter preserve every evaluation byte-for-byte", () => {
  for (const [name, canonical] of Object.entries(canonicalCases)) {
    const original = evaluatePromise(canonical);
    const roundTripped = evaluatePromise(
      adaptExternalEvidence(projectCanonicalEvidence(canonical)),
    );

    assert.equal(stable(roundTripped), stable(original), name);
  }
});

test("every evaluator-relevant public field has mutation coverage", () => {
  const mutationCases: Array<{
    name: string;
    bundle: ExternalBundle;
    mutate: (bundle: ExternalBundle) => void;
    invalid?: boolean;
  }> = [
    {
      name: "scenario",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.scenario = "on";
      },
    },
    {
      name: "subjectId",
      bundle: passingOnExample,
      mutate: (item) => {
        item.evidence.subjectId = "different-subject";
      },
    },
    ...([
      ["uiPreference", "on"],
      ["toggleChecked", true],
      ["storedPreference", "on"],
      ["backendPreference", "on"],
      ["reloadObserved", false],
    ] as const).map(([field, value]) => ({
      name: `control.${field}`,
      bundle: passingOffExample,
      mutate: (item: ExternalBundle) => {
        Object.assign(item.evidence.control, { [field]: value });
      },
    })),
    {
      name: "capturedActivities",
      bundle: passingOnExample,
      mutate: (item) => {
        item.evidence.activity.capturedActivities = [];
      },
    },
    {
      name: "recommendationServiceActivityReceipts",
      bundle: passingOnExample,
      mutate: (item) => {
        item.evidence.activity.recommendationServiceReceipts = [];
      },
    },
    ...(["runId", "subjectId", "itemId", "clientSequence", "occurredAt"] as const)
      .flatMap((field) => [
        {
          name: `capturedActivity.${field}`,
          bundle: passingOnExample,
          mutate: (item: ExternalBundle) => {
            Object.assign(item.evidence.activity.capturedActivities[0]!, {
              [field]:
                field === "clientSequence"
                  ? 2
                  : field === "occurredAt"
                    ? "2026-01-15T12:00:02.000Z"
                    : `different-${field}`,
            });
          },
        },
        {
          name: `activityReceipt.${field}`,
          bundle: passingOnExample,
          mutate: (item: ExternalBundle) => {
            Object.assign(
              item.evidence.activity.recommendationServiceReceipts[0]!,
              {
                [field]:
                  field === "clientSequence"
                    ? 2
                    : field === "occurredAt"
                      ? "2026-01-15T12:00:02.000Z"
                      : `different-${field}`,
              },
            );
          },
        },
      ]),
    {
      name: "capturedActivity.eventType",
      bundle: passingOnExample,
      invalid: true,
      mutate: (item) => {
        Object.assign(item.evidence.activity.capturedActivities[0]!, {
          eventType: "click",
        });
      },
    },
    {
      name: "activityReceipt.eventType",
      bundle: passingOnExample,
      invalid: true,
      mutate: (item) => {
        Object.assign(
          item.evidence.activity.recommendationServiceReceipts[0]!,
          { eventType: "click" },
        );
      },
    },
    {
      name: "feedFunctional",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.feedFunctional = false;
      },
    },
    {
      name: "renderedSource",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.renderedSource = "behavioral";
      },
    },
    {
      name: "renderedItemIds",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.renderedItemIds = ["different-item"];
      },
    },
    {
      name: "recommendationServiceReceipts",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.recommendationServiceReceipts = [];
      },
    },
    {
      name: "recommendationReceipt.source",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.recommendationServiceReceipts[0]!.source =
          "behavioral";
      },
    },
    {
      name: "recommendationReceipt.subjectId",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.recommendationServiceReceipts[0]!.subjectId =
          item.evidence.subjectId;
      },
    },
    {
      name: "recommendationReceipt.itemIds",
      bundle: passingOffExample,
      mutate: (item) => {
        item.evidence.recommendations.recommendationServiceReceipts[0]!.itemIds =
          ["different-item"];
      },
    },
  ];

  for (const mutation of mutationCases) {
    const candidate = clone(mutation.bundle);
    const baseline = verifyBundle(mutation.bundle);
    mutation.mutate(candidate);
    const changed = verifyBundle(candidate);

    if (mutation.invalid) {
      assert.equal(changed.outcome, "INVALID_EVIDENCE", mutation.name);
    } else {
      assert.notEqual(
        stable(changed.evaluation),
        stable(baseline.evaluation),
        mutation.name,
      );
      assert.equal(changed.outcome, "BROKEN_PROMISE", mutation.name);
    }
  }
});

test("committed schema and scaffold text are generated from runtime definitions", async () => {
  const artifactRoot = path.join(projectRoot, "artifacts", "verify");
  const committedSchema = await readFile(
    path.join(artifactRoot, "activity-personalization.v1.schema.json"),
    "utf8",
  );

  assert.equal(
    committedSchema,
    `${JSON.stringify(externalBundleJsonSchema(), null, 2)}\n`,
  );
  assert.equal(
    await readFile(path.join(artifactRoot, "producer-template.mjs"), "utf8"),
    producerTemplate,
  );
  assert.equal(
    await readFile(path.join(artifactRoot, "README.md"), "utf8"),
    scaffoldReadme,
  );
  assert.ok(committedSchema.split("\n").length < 400);
  assert.ok(Buffer.byteLength(committedSchema) < 16_000);
});

test("Article Atlas examples remain independent and one-family only", () => {
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
});

test("external verifier modules have no forbidden implementation imports", async () => {
  const verifyDirectory = path.join(projectRoot, "src", "verify");
  const filenames = [
    "adapter.ts",
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
});
