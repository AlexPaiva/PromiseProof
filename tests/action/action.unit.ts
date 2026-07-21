import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EVALUATOR_SOURCE_SHA256 } from "../../src/verify/binding.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
} from "../../src/verify/examples.js";
import { createGateReport } from "../../src/verify/report.js";
import { runGate } from "../../src/verify/verify.js";

const BUNDLE = path.join(process.cwd(), ".github/actions/verify/dist/index.js");

interface RunResult {
  code: number | null;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  workspace: string;
}

// Parse the GITHUB_OUTPUT heredoc format the action writes.
function parseOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([a-z0-9_]+)<<(.+)$/.exec(lines[i]!);
    if (match === null) continue;
    const [, name, delimiter] = match;
    const buffer: string[] = [];
    i += 1;
    while (i < lines.length && lines[i] !== delimiter) {
      buffer.push(lines[i]!);
      i += 1;
    }
    out[name!] = buffer.join("\n");
  }
  return out;
}

function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("INPUT_") || key.startsWith("GITHUB_") || key === "OPENAI_API_KEY") {
      delete env[key];
    }
  }
  return env;
}

interface RunOptions {
  files?: Record<string, string>;
  inputs: Record<string, string>;
  omitWorkspace?: boolean;
}

function runAction(opts: RunOptions): RunResult {
  const workspace = mkdtempSync(path.join(tmpdir(), "pp-ws-"));
  const runnerDir = mkdtempSync(path.join(tmpdir(), "pp-runner-"));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(workspace, rel);
    writeFileSync(target, content);
  }
  const outputFile = path.join(runnerDir, "output");
  const summaryFile = path.join(runnerDir, "summary.md");
  writeFileSync(outputFile, "");
  writeFileSync(summaryFile, "");

  const env = baseEnv();
  if (!opts.omitWorkspace) env.GITHUB_WORKSPACE = workspace;
  env.GITHUB_OUTPUT = outputFile;
  env.GITHUB_STEP_SUMMARY = summaryFile;
  for (const [name, value] of Object.entries(opts.inputs)) {
    env[`INPUT_${name.toUpperCase()}`] = value;
  }

  const result = spawnSync(process.execPath, [BUNDLE], { env, encoding: "utf8" });
  return {
    code: result.status,
    outputs: parseOutputs(outputFile),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    workspace,
  };
}

const OFF = JSON.stringify(passingOffExample);
const ON = JSON.stringify(passingOnExample);
const BROKEN_OFF = JSON.stringify(brokenOffExample);

async function genuineGateReportJson(off: unknown, on: unknown): Promise<string> {
  const report = await createGateReport(runGate(off, on));
  return `${JSON.stringify(report, null, 2)}\n`;
}

test("verify passing evidence succeeds with PASS and writes reports", () => {
  const r = runAction({
    files: { "off.json": OFF },
    inputs: { mode: "verify", evidence: "off.json", output_directory: "out" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, "PASS");
  assert.equal(r.outputs.mode, "verify");
  assert.ok(existsSync(path.join(r.workspace, "out/report.json")));
  assert.ok(existsSync(path.join(r.workspace, "out/report.md")));
  assert.match(r.outputs.evidence_sha256!, /^[0-9a-f]{64}$/);
  assert.equal(r.outputs.evaluator_sha256, EVALUATOR_SOURCE_SHA256);
});

test("verify broken evidence fails exit 2 but still writes reports and outputs", () => {
  const r = runAction({
    files: { "off.json": BROKEN_OFF },
    inputs: { mode: "verify", evidence: "off.json", output_directory: "out" },
  });
  assert.equal(r.code, 2);
  assert.equal(r.outputs.status, "BROKEN_PROMISE");
  assert.ok(existsSync(path.join(r.workspace, "out/report.json")));
  assert.ok(existsSync(path.join(r.workspace, "out/report.md")));
});

test("gate passing OFF and ON succeeds with distinct digests", () => {
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON },
    inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "on.json", output_directory: "out" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, "PASS");
  assert.match(r.outputs.off_evidence_sha256!, /^[0-9a-f]{64}$/);
  assert.match(r.outputs.on_evidence_sha256!, /^[0-9a-f]{64}$/);
  assert.notEqual(r.outputs.off_evidence_sha256, r.outputs.on_evidence_sha256);
});

test("gate broken OFF plus passing ON fails exit 2 with an honest BROKEN report", () => {
  const r = runAction({
    files: { "off.json": BROKEN_OFF, "on.json": ON },
    inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "on.json", output_directory: "out" },
  });
  assert.equal(r.code, 2);
  assert.equal(r.outputs.status, "BROKEN_PROMISE");
  const report = JSON.parse(readFileSync(path.join(r.workspace, "out/report.json"), "utf8"));
  assert.equal(report.outcome, "BROKEN_PROMISE");
});

test("invalid evidence fails exit 3 and creates no canonical report", () => {
  const r = runAction({
    files: { "bad.json": JSON.stringify({ not: "a bundle" }) },
    inputs: { mode: "verify", evidence: "bad.json", output_directory: "out" },
  });
  assert.equal(r.code, 3);
  assert.equal(r.outputs.status, "INVALID_EVIDENCE");
  assert.ok(!existsSync(path.join(r.workspace, "out/report.json")));
});

test("check genuine gate report succeeds with BOUND_AND_REPRODUCED", async () => {
  const report = await genuineGateReportJson(passingOffExample, passingOnExample);
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON, "report.json": report },
    inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "on.json" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, "BOUND_AND_REPRODUCED");
});

test("check against changed evidence fails exit 4 (STALE_OR_MISMATCH)", async () => {
  const report = await genuineGateReportJson(passingOffExample, passingOnExample);
  const r = runAction({
    files: { "off.json": BROKEN_OFF, "on.json": ON, "report.json": report },
    inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "on.json" },
  });
  assert.equal(r.code, 4);
  assert.equal(r.outputs.status, "STALE_OR_MISMATCH");
});

test("check an invented PASS with genuine bindings fails exit 4", async () => {
  const genuine = JSON.parse(await genuineGateReportJson(brokenOffExample, passingOnExample));
  genuine.outcome = "PASS";
  genuine.evaluations.off.canonicalVerdict = "pass";
  genuine.evaluations.off.violations = [];
  const r = runAction({
    files: { "off.json": BROKEN_OFF, "on.json": ON, "report.json": `${JSON.stringify(genuine, null, 2)}\n` },
    inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "on.json" },
  });
  assert.equal(r.code, 4);
  assert.equal(r.outputs.status, "STALE_OR_MISMATCH");
});

test("check a malformed report fails exit 3 (INVALID_REPORT_OR_EVIDENCE)", () => {
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON, "report.json": "{not-json" },
    inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "on.json" },
  });
  assert.equal(r.code, 3);
  assert.equal(r.outputs.status, "INVALID_REPORT_OR_EVIDENCE");
});

test("contradictory input combinations fail exit 1 (EXECUTION_ERROR)", () => {
  const r = runAction({
    files: { "off.json": OFF, "report.json": "{}" },
    inputs: { mode: "verify", evidence: "off.json", report: "report.json" },
  });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, "EXECUTION_ERROR");
});

test("missing GITHUB_WORKSPACE fails safely exit 1", () => {
  const r = runAction({
    files: { "off.json": OFF },
    inputs: { mode: "verify", evidence: "off.json" },
    omitWorkspace: true,
  });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, "EXECUTION_ERROR");
});

test("an absolute path outside the workspace is rejected", () => {
  const outside = path.join(tmpdir(), "pp-outside-evidence.json");
  writeFileSync(outside, OFF);
  const r = runAction({
    inputs: { mode: "verify", evidence: outside },
  });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, "EXECUTION_ERROR");
});

test("a parent-traversal path is rejected", () => {
  const r = runAction({
    files: { "off.json": OFF },
    inputs: { mode: "verify", evidence: "../../../etc/passwd" },
  });
  assert.equal(r.code, 1);
  assert.equal(r.outputs.status, "EXECUTION_ERROR");
});

test("paths and output directories containing spaces work", () => {
  const r = runAction({
    files: { "off bundle.json": OFF },
    inputs: { mode: "verify", evidence: "off bundle.json", output_directory: "out dir" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, "PASS");
  assert.ok(existsSync(path.join(r.workspace, "out dir/report.json")));
});

test("the step summary carries the report but not raw evidence payload fields", () => {
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON },
    inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "on.json", output_directory: "out" },
  });
  assert.equal(r.code, 0);
  assert.match(r.summary, /PromiseProof Verify/);
  assert.match(r.summary, /activity-personalization\/v1/);
  for (const leaked of ["clientSequence", "occurredAt", "capturedActivities", "recommendationServiceReceipts"]) {
    assert.ok(!r.summary.includes(leaked), `summary should not contain raw field ${leaked}`);
  }
});

test("the action needs no OpenAI key (runs with the key unset)", () => {
  // baseEnv already strips OPENAI_API_KEY; a clean PASS proves independence.
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON },
    inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "on.json" },
  });
  assert.equal(r.code, 0);
  assert.equal(r.outputs.status, "PASS");
});
