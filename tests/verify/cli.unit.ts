import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";

import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
} from "../../src/verify/examples.js";
import { bindExternalBundle } from "../../src/verify/binding.js";
import { MAX_INPUT_BYTES } from "../../src/verify/schema.js";

const projectRoot = process.cwd();
const temporaryRoots: string[] = [];

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "promiseproof-cli-test-"));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runCli(args: readonly string[]): CliResult {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  env.OPENAI_BASE_URL = "http://127.0.0.1:9/no-network";
  env.CODEX_HOME = path.join(os.tmpdir(), "promiseproof-no-codex-home");

  const result = spawnSync(
    process.execPath,
    [
      path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(projectRoot, "src", "verify", "cli.ts"),
      ...args,
    ],
    {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

after(async () => {
  await Promise.all(
    temporaryRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("CLI verifies broken OFF with exit 2 and deterministic reports", async () => {
  const root = await temporaryRoot();
  const evidence = path.join(root, "broken-off.json");
  const output = path.join(root, "report");
  await writeJson(evidence, brokenOffExample);

  const result = runCli([
    "verify",
    "--evidence",
    evidence,
    "--out",
    output,
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /^BROKEN_PROMISE/);
  const report = JSON.parse(
    await readFile(path.join(output, "report.json"), "utf8"),
  ) as { outcome: string; violations: Array<{ code: string }> };
  assert.equal(report.outcome, "BROKEN_PROMISE");
  assert.deepEqual(report.violations.map((item) => item.code), [
    "PP_IDENTIFIABLE_EVENT_LEAK",
  ]);
});

test("CLI verifies passing OFF and ON with exit 0 without API key, network, browser, or Codex", async () => {
  const root = await temporaryRoot();
  const off = path.join(root, "passing-off.json");
  const on = path.join(root, "passing-on.json");
  await writeJson(off, passingOffExample);
  await writeJson(on, passingOnExample);

  for (const [filename, directory] of [
    [off, "off-report"],
    [on, "on-report"],
  ] as const) {
    const result = runCli([
      "verify",
      "--evidence",
      filename,
      "--out",
      path.join(root, directory),
    ]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^PASS/);
    assert.equal(result.stderr, "");
  }
});

test("CLI verifies broken ON with exit 2", async () => {
  const root = await temporaryRoot();
  const brokenOn = clone(passingOnExample);
  brokenOn.evidence.activity.recommendationServiceReceipts = [];
  const evidence = path.join(root, "broken-on.json");
  await writeJson(evidence, brokenOn);

  const result = runCli([
    "verify",
    "--evidence",
    evidence,
    "--out",
    path.join(root, "report"),
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stdout, /^BROKEN_PROMISE/);
});

test("CLI gate passes only passing OFF plus passing ON", async () => {
  const root = await temporaryRoot();
  const off = path.join(root, "passing-off.json");
  const brokenOff = path.join(root, "broken-off.json");
  const on = path.join(root, "passing-on.json");
  await writeJson(off, passingOffExample);
  await writeJson(brokenOff, brokenOffExample);
  await writeJson(on, passingOnExample);

  const passing = runCli([
    "gate",
    "--off",
    off,
    "--on",
    on,
    "--out",
    path.join(root, "passing-gate"),
  ]);
  const broken = runCli([
    "gate",
    "--off",
    brokenOff,
    "--on",
    on,
    "--out",
    path.join(root, "broken-gate"),
  ]);

  assert.equal(passing.status, 0);
  assert.equal(broken.status, 2);
  const gateReport = JSON.parse(
    await readFile(path.join(root, "passing-gate", "report.json"), "utf8"),
  ) as {
    evaluations: {
      off: { canonicalVerdict: string };
      on: { canonicalVerdict: string };
    };
  };
  assert.equal(gateReport.evaluations.off.canonicalVerdict, "pass");
  assert.equal(gateReport.evaluations.on.canonicalVerdict, "pass");
});

test("CLI returns INVALID_EVIDENCE for malformed JSON and missing fields", async () => {
  const root = await temporaryRoot();
  const malformed = path.join(root, "malformed.json");
  const missing = path.join(root, "missing.json");
  await writeFile(malformed, "{not json", "utf8");
  await writeJson(missing, {
    schemaVersion: "1",
    contractFamily: "activity-personalization/v1",
    evidence: {},
  });

  for (const [filename, reportName] of [
    [malformed, "malformed-report"],
    [missing, "missing-report"],
  ] as const) {
    const result = runCli([
      "verify",
      "--evidence",
      filename,
      "--out",
      path.join(root, reportName),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /^INVALID_EVIDENCE/m);
  }
});

test("CLI rejects unknown keys, schema versions, and contract families with exit 3", async () => {
  const root = await temporaryRoot();
  const candidates = [
    Object.assign(clone(passingOffExample), { unexpected: true }),
    Object.assign(clone(passingOffExample), { schemaVersion: "2" }),
    Object.assign(clone(passingOffExample), {
      contractFamily: "arbitrary-promise/v1",
    }),
  ];

  for (const [index, candidate] of candidates.entries()) {
    const evidence = path.join(root, `invalid-${index}.json`);
    await writeJson(evidence, candidate);
    const result = runCli([
      "verify",
      "--evidence",
      evidence,
      "--out",
      path.join(root, `report-${index}`),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /^INVALID_EVIDENCE/m);
  }
});

test("CLI rejects a wrong gate scenario slot with exit 3", async () => {
  const root = await temporaryRoot();
  const off = path.join(root, "off.json");
  const on = path.join(root, "on.json");
  await writeJson(off, passingOnExample);
  await writeJson(on, passingOffExample);

  const result = runCli([
    "gate",
    "--off",
    off,
    "--on",
    on,
    "--out",
    path.join(root, "gate"),
  ]);

  assert.equal(result.status, 3);
  assert.match(result.stderr, /--off bundle must contain OFF-scenario evidence/);
  assert.match(result.stderr, /--on bundle must contain ON-scenario evidence/);
});

test("CLI rejects oversized input and bounded collection overflow with exit 3", async () => {
  const root = await temporaryRoot();
  const oversized = path.join(root, "oversized.json");
  const collection = path.join(root, "collection.json");
  await writeFile(oversized, " ".repeat(MAX_INPUT_BYTES + 1), "utf8");
  const tooMany = clone(passingOffExample);
  tooMany.evidence.recommendations.renderedItemIds = Array.from(
    { length: 101 },
    (_, index) => `article-${index}`,
  );
  await writeJson(collection, tooMany);

  for (const [filename, output] of [
    [oversized, "oversized-report"],
    [collection, "collection-report"],
  ] as const) {
    const result = runCli([
      "verify",
      "--evidence",
      filename,
      "--out",
      path.join(root, output),
    ]);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /^INVALID_EVIDENCE/m);
  }
});

test("CLI scaffold is complete and refuses conflicting files", async () => {
  const root = await temporaryRoot();
  const output = path.join(root, "scaffold");

  const first = runCli(["init", "--out", output]);
  const second = runCli(["init", "--out", output]);

  assert.equal(first.status, 0);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Refusing to overwrite existing scaffold file/);
  for (const filename of [
    "activity-personalization.v1.schema.json",
    "broken-off.example.json",
    "passing-off.example.json",
    "passing-on.example.json",
    "producer-template.mjs",
    "README.md",
  ]) {
    assert.ok((await readFile(path.join(output, filename))).byteLength > 0);
  }
});

test("CLI unknown command, missing argument, and output traversal are usage errors", async () => {
  const unknown = runCli(["unknown"]);
  const missing = runCli(["verify", "--evidence", "bundle.json"]);
  const traversal = runCli(["init", "--out", "../escaped"]);

  for (const result of [unknown, missing, traversal]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /USAGE_ERROR/);
  }
});

test("CLI creates byte-identical JSON and Markdown across repeated runs", async () => {
  const root = await temporaryRoot();
  const evidence = path.join(root, "passing-off.json");
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  await writeJson(evidence, passingOffExample);

  const firstResult = runCli([
    "verify",
    "--evidence",
    evidence,
    "--out",
    first,
  ]);
  const secondResult = runCli([
    "verify",
    "--evidence",
    evidence,
    "--out",
    second,
  ]);

  assert.equal(firstResult.status, 0);
  assert.equal(secondResult.status, 0);
  assert.deepEqual(
    await readFile(path.join(first, "report.json")),
    await readFile(path.join(second, "report.json")),
  );
  assert.deepEqual(
    await readFile(path.join(first, "report.md")),
    await readFile(path.join(second, "report.md")),
  );
});

test("CLI uses the shared canonical binding and changes reports for semantic input changes", async () => {
  const root = await temporaryRoot();
  const reorderedPath = path.join(root, "reordered.json");
  const changedPath = path.join(root, "changed.json");
  const reorderedOutput = path.join(root, "reordered-report");
  const changedOutput = path.join(root, "changed-report");
  const reordered = {
    evidence: {
      recommendations: passingOffExample.evidence.recommendations,
      activity: passingOffExample.evidence.activity,
      control: passingOffExample.evidence.control,
      subjectId: passingOffExample.evidence.subjectId,
      scenario: passingOffExample.evidence.scenario,
    },
    contractFamily: passingOffExample.contractFamily,
    schemaVersion: passingOffExample.schemaVersion,
  };
  const changed = clone(passingOffExample);
  changed.evidence.subjectId = "article-atlas-reader-002";
  await writeFile(reorderedPath, JSON.stringify(reordered), "utf8");
  await writeJson(changedPath, changed);

  assert.equal(
    runCli([
      "verify",
      "--evidence",
      reorderedPath,
      "--out",
      reorderedOutput,
    ]).status,
    0,
  );
  assert.equal(
    runCli([
      "verify",
      "--evidence",
      changedPath,
      "--out",
      changedOutput,
    ]).status,
    0,
  );

  const reorderedReport = JSON.parse(
    await readFile(path.join(reorderedOutput, "report.json"), "utf8"),
  ) as { inputBinding: { sha256: string } };
  const changedReport = JSON.parse(
    await readFile(path.join(changedOutput, "report.json"), "utf8"),
  ) as { inputBinding: { sha256: string } };
  assert.equal(
    reorderedReport.inputBinding.sha256,
    (await bindExternalBundle(passingOffExample)).sha256,
  );
  assert.match(
    await readFile(path.join(reorderedOutput, "report.md"), "utf8"),
    new RegExp(reorderedReport.inputBinding.sha256, "u"),
  );
  assert.notEqual(
    reorderedReport.inputBinding.sha256,
    changedReport.inputBinding.sha256,
  );
  assert.notDeepEqual(
    await readFile(path.join(reorderedOutput, "report.json")),
    await readFile(path.join(changedOutput, "report.json")),
  );
  assert.notDeepEqual(
    await readFile(path.join(reorderedOutput, "report.md")),
    await readFile(path.join(changedOutput, "report.md")),
  );
});

test("CLI help succeeds and documents commands and exit codes", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /init --out/);
  assert.match(result.stdout, /verify --evidence/);
  assert.match(result.stdout, /gate --off/);
  assert.match(result.stdout, /3  INVALID_EVIDENCE/);
});

test("CLI check distinguishes malformed reports from valid semantic mismatches", async () => {
  const root = await temporaryRoot();
  const off = path.join(root, "off.json");
  const on = path.join(root, "on.json");
  const output = path.join(root, "output");
  const reportPath = path.join(output, "report.json");
  await writeJson(off, passingOffExample);
  await writeJson(on, passingOnExample);
  assert.equal(
    runCli(["gate", "--off", off, "--on", on, "--out", output]).status,
    0,
  );

  await writeJson(reportPath, { schemaVersion: "2" });
  const malformed = runCli([
    "check",
    "--report",
    reportPath,
    "--off",
    off,
    "--on",
    on,
  ]);
  assert.equal(malformed.status, 3);
  assert.match(malformed.stdout, /INVALID_REPORT_OR_EVIDENCE/);

  const genuineOutput = path.join(root, "genuine");
  assert.equal(
    runCli(["gate", "--off", off, "--on", on, "--out", genuineOutput]).status,
    0,
  );
  const forged = JSON.parse(
    await readFile(path.join(genuineOutput, "report.json"), "utf8"),
  );
  forged.outcome = "BROKEN_PROMISE";
  await writeJson(reportPath, forged);
  const mismatch = runCli([
    "check",
    "--report",
    reportPath,
    "--off",
    off,
    "--on",
    on,
  ]);
  assert.equal(mismatch.status, 4);
  assert.match(mismatch.stdout, /STALE_OR_MISMATCH/);
});
