import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { EVALUATOR_SOURCE_SHA256 } from "../../src/verify/binding.js";
import {
  brokenOffExample,
  passingOffExample,
  passingOnExample,
} from "../../src/verify/examples.js";
import { createGateReport, createVerifyReport } from "../../src/verify/report.js";
import { MAX_INPUT_BYTES } from "../../src/verify/schema.js";
import { runGate, verifyBundle } from "../../src/verify/verify.js";

const BUNDLE = path.join(process.cwd(), ".github/actions/verify/dist/index.js");

interface RunResult {
  code: number | null;
  outputs: Record<string, string>;
  summary: string;
  stdout: string;
  stderr: string;
  workspace: string;
  outside: string;
  outputFileContents: string;
}

const OUTPUT_NAMES = [
  "status",
  "mode",
  "report_json",
  "report_markdown",
  "evaluator_sha256",
  "evidence_sha256",
  "off_evidence_sha256",
  "on_evidence_sha256",
] as const;

function parseOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const assignment = /^([a-z0-9_]+)=(.*)$/u.exec(lines[i]!);
    if (assignment !== null) {
      out[assignment[1]!] = assignment[2]!;
      continue;
    }
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
  setup?: (workspace: string, outside: string) => void;
}

function runAction(opts: RunOptions): RunResult {
  const workspace = mkdtempSync(path.join(tmpdir(), "pp-ws-"));
  const outside = mkdtempSync(path.join(tmpdir(), "pp-outside-"));
  const runnerDir = mkdtempSync(path.join(tmpdir(), "pp-runner-"));
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const target = path.join(workspace, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  opts.setup?.(workspace, outside);
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
  const outputFileContents = readFileSync(outputFile, "utf8");
  return {
    code: result.status,
    outputs: parseOutputs(outputFile),
    summary: existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "",
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    workspace,
    outside,
    outputFileContents,
  };
}

const OFF = JSON.stringify(passingOffExample);
const ON = JSON.stringify(passingOnExample);
const BROKEN_OFF = JSON.stringify(brokenOffExample);

async function genuineGateReportJson(off: unknown, on: unknown): Promise<string> {
  const report = await createGateReport(runGate(off, on));
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function genuineSingleReportJson(evidence: unknown): Promise<string> {
  const report = await createVerifyReport(verifyBundle(evidence));
  return `${JSON.stringify(report, null, 2)}\n`;
}

function assertEveryOutputPresent(result: RunResult): void {
  for (const name of OUTPUT_NAMES) {
    assert.ok(Object.hasOwn(result.outputs, name), `missing declared output ${name}`);
  }
}

function oversizedJson(): string {
  return JSON.stringify({ padding: "x".repeat(MAX_INPUT_BYTES) });
}

function tryCreateFileSymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw error;
  }
}

function tryCreateDirectorySymlink(target: string, link: string): boolean {
  try {
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") return false;
    throw error;
  }
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
  assert.equal(r.outputs.evidence_sha256, "");
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
  assert.ok(existsSync(path.join(r.workspace, "out/report.md")));
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

test("the step summary carries safe results but no externally supplied evidence values", () => {
  const r = runAction({
    files: { "off.json": OFF, "on.json": ON },
    inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "on.json", output_directory: "out" },
  });
  assert.equal(r.code, 0);
  assert.match(r.summary, /PromiseProof Verify/);
  assert.match(r.summary, /activity-personalization\/v1/);
  for (const leaked of [
    "clientSequence",
    "occurredAt",
    "capturedActivities",
    "recommendationServiceReceipts",
    passingOffExample.evidence.subjectId,
    passingOnExample.evidence.subjectId,
    passingOnExample.evidence.activity.capturedActivities[0]!.itemId,
  ]) {
    assert.ok(!r.summary.includes(leaked), `summary should not contain raw field ${leaked}`);
  }
  assert.match(r.summary, /expected_activity_received: PASS/u);
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

test("oversized evidence and reports retain verdict-safe exit classifications", async () => {
  const huge = oversizedJson();
  assert.ok(Buffer.byteLength(huge, "utf8") > MAX_INPUT_BYTES);
  const singleReport = await genuineSingleReportJson(passingOffExample);
  const gateReport = await genuineGateReportJson(passingOffExample, passingOnExample);
  const cases = [
    {
      name: "verify evidence",
      files: { "huge.json": huge },
      inputs: { mode: "verify", evidence: "huge.json", output_directory: "out" },
      status: "INVALID_EVIDENCE",
    },
    {
      name: "gate OFF evidence",
      files: { "huge.json": huge, "on.json": ON },
      inputs: { mode: "gate", off_evidence: "huge.json", on_evidence: "on.json", output_directory: "out" },
      status: "INVALID_EVIDENCE",
    },
    {
      name: "gate ON evidence",
      files: { "off.json": OFF, "huge.json": huge },
      inputs: { mode: "gate", off_evidence: "off.json", on_evidence: "huge.json", output_directory: "out" },
      status: "INVALID_EVIDENCE",
    },
    {
      name: "check report",
      files: { "huge.json": huge, "off.json": OFF, "on.json": ON },
      inputs: { mode: "check", report: "huge.json", off_evidence: "off.json", on_evidence: "on.json" },
      status: "INVALID_REPORT_OR_EVIDENCE",
    },
    {
      name: "single-check evidence",
      files: { "report.json": singleReport, "huge.json": huge },
      inputs: { mode: "check", report: "report.json", evidence: "huge.json" },
      status: "INVALID_REPORT_OR_EVIDENCE",
    },
    {
      name: "gate-check OFF evidence",
      files: { "report.json": gateReport, "huge.json": huge, "on.json": ON },
      inputs: { mode: "check", report: "report.json", off_evidence: "huge.json", on_evidence: "on.json" },
      status: "INVALID_REPORT_OR_EVIDENCE",
    },
    {
      name: "gate-check ON evidence",
      files: { "report.json": gateReport, "off.json": OFF, "huge.json": huge },
      inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "huge.json" },
      status: "INVALID_REPORT_OR_EVIDENCE",
    },
  ] as const;

  for (const item of cases) {
    const result = runAction({ files: item.files, inputs: item.inputs });
    assert.equal(result.code, 3, item.name);
    assert.equal(result.outputs.status, item.status, item.name);
    assertEveryOutputPresent(result);
    assert.equal(result.outputs.report_json, "", item.name);
    assert.equal(result.outputs.report_markdown, "", item.name);
    assert.equal(result.outputs.evidence_sha256, "", item.name);
    assert.equal(result.outputs.off_evidence_sha256, "", item.name);
    assert.equal(result.outputs.on_evidence_sha256, "", item.name);
  }
});

test("invalid evidence clears stale PASS and BROKEN reports but preserves unrelated files", () => {
  for (const prior of ["PASS", "BROKEN_PROMISE"]) {
    const result = runAction({
      files: {
        "bad.json": JSON.stringify({ not: "a bundle" }),
        "out/report.json": `old ${prior}`,
        "out/report.md": `old ${prior}`,
        "out/keep.txt": "preserve me",
      },
      inputs: { mode: "verify", evidence: "bad.json", output_directory: "out" },
    });
    assert.equal(result.code, 3);
    assert.equal(result.outputs.status, "INVALID_EVIDENCE");
    assert.ok(!existsSync(path.join(result.workspace, "out/report.json")));
    assert.ok(!existsSync(path.join(result.workspace, "out/report.md")));
    assert.equal(readFileSync(path.join(result.workspace, "out/keep.txt"), "utf8"), "preserve me");
  }

  const gate = runAction({
    files: {
      "off.json": OFF,
      "bad.json": "{}",
      "out/report.json": "old PASS",
      "out/report.md": "old PASS",
      "out/keep.txt": "preserve me",
    },
    inputs: {
      mode: "gate",
      off_evidence: "off.json",
      on_evidence: "bad.json",
      output_directory: "out",
    },
  });
  assert.equal(gate.code, 3);
  assert.equal(gate.outputs.status, "INVALID_EVIDENCE");
  assert.ok(!existsSync(path.join(gate.workspace, "out/report.json")));
  assert.ok(!existsSync(path.join(gate.workspace, "out/report.md")));
  assert.equal(readFileSync(path.join(gate.workspace, "out/keep.txt"), "utf8"), "preserve me");
});

test("invalid-evidence summaries reveal counts but no hostile paths or values", () => {
  const hostile = structuredClone(passingOffExample) as Record<string, unknown>;
  const evidence = hostile.evidence as Record<string, unknown>;
  evidence.subjectId = "PP_PRIVATE_SENTINEL\n![x](https://invalid.example)<img>` ``` | ::error::";
  evidence["PP_UNKNOWN_SENTINEL\r\n![leak](https://invalid.example)<script>"] = true;
  const result = runAction({
    files: { "hostile.json": JSON.stringify(hostile) },
    inputs: { mode: "verify", evidence: "hostile.json", output_directory: "out" },
  });
  assert.equal(result.code, 3);
  assert.equal(result.outputs.status, "INVALID_EVIDENCE");
  assert.match(result.summary, /Validation issue count: 2\./u);
  for (const fragment of [
    "PP_PRIVATE_SENTINEL",
    "PP_UNKNOWN_SENTINEL",
    "invalid.example",
    "<img>",
    "<script>",
    "::error::",
    "```",
  ]) {
    assert.ok(!result.summary.includes(fragment), `summary leaked ${fragment}`);
  }
});

test("path control and bidi characters fail before filesystem access or command injection", () => {
  for (const hostilePath of [
    "missing\n::error::PP_FORGED",
    "missing\rPP_FORGED",
    "missing\tPP_FORGED",
    "missing\u202ePP_FORGED",
    "missing\u2066PP_FORGED",
  ]) {
    const result = runAction({
      inputs: { mode: "verify", evidence: hostilePath, output_directory: "out" },
    });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.status, "EXECUTION_ERROR");
    assert.equal(result.outputs.report_json, "");
    assert.equal(result.outputs.evidence_sha256, "");
    assert.ok(!result.stdout.includes("PP_FORGED"));
    assert.equal((result.stdout.match(/::error::/gu) ?? []).length, 1);
  }
});

test("workflow command messages percent-encode line breaks and percent signs", () => {
  const result = runAction({
    inputs: {
      mode: "bad%0A\r\n::error::PP_FORGED",
    },
  });
  assert.equal(result.code, 1);
  assert.equal(result.outputs.status, "EXECUTION_ERROR");
  const commandLines = result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("::"));
  assert.equal(commandLines.length, 1);
  assert.ok(commandLines[0]!.startsWith("::error::"));
  assert.ok(!result.stdout.includes("PP_FORGED"));
});

test("single-line GITHUB_OUTPUT resists delimiter and percent-shaped filenames", () => {
  const filename = "proof 100% ghadelim_status_4 日本語.json";
  const result = runAction({
    files: { [filename]: OFF },
    inputs: { mode: "verify", evidence: filename, output_directory: "result 100% 日本語" },
  });
  assert.equal(result.code, 0);
  assertEveryOutputPresent(result);
  assert.ok(!result.outputFileContents.includes("<<"));
  assert.equal(result.outputs.report_json, "result 100% 日本語/report.json");
  assert.equal(result.outputs.report_markdown, "result 100% 日本語/report.md");
  const names = result.outputFileContents
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf("=")));
  assert.ok(names.every((name) => OUTPUT_NAMES.includes(name as typeof OUTPUT_NAMES[number])));
});

test("genuine single check succeeds and exposes only the single evidence digest", async () => {
  const report = await genuineSingleReportJson(passingOffExample);
  const result = runAction({
    files: { "off.json": OFF, "report.json": report },
    inputs: { mode: "check", report: "report.json", evidence: "off.json" },
  });
  assert.equal(result.code, 0);
  assert.equal(result.outputs.status, "BOUND_AND_REPRODUCED");
  assert.match(result.outputs.evidence_sha256!, /^[0-9a-f]{64}$/u);
  assert.equal(result.outputs.off_evidence_sha256, "");
  assert.equal(result.outputs.on_evidence_sha256, "");
  assert.equal(result.outputs.report_json, "");
  assert.equal(result.outputs.report_markdown, "");
});

test("changed single evidence is stale while malformed and wrong-kind reports are invalid", async () => {
  const report = await genuineSingleReportJson(passingOffExample);
  const stale = runAction({
    files: { "off.json": BROKEN_OFF, "report.json": report },
    inputs: { mode: "check", report: "report.json", evidence: "off.json" },
  });
  assert.equal(stale.code, 4);
  assert.equal(stale.outputs.status, "STALE_OR_MISMATCH");
  assert.match(stale.outputs.evidence_sha256!, /^[0-9a-f]{64}$/u);

  const malformed = runAction({
    files: { "off.json": OFF, "report.json": "{not-json" },
    inputs: { mode: "check", report: "report.json", evidence: "off.json" },
  });
  assert.equal(malformed.code, 3);
  assert.equal(malformed.outputs.status, "INVALID_REPORT_OR_EVIDENCE");
  assert.equal(malformed.outputs.evidence_sha256, "");

  const gateReport = await genuineGateReportJson(passingOffExample, passingOnExample);
  const wrongKind = runAction({
    files: { "off.json": OFF, "report.json": gateReport },
    inputs: { mode: "check", report: "report.json", evidence: "off.json" },
  });
  assert.equal(wrongKind.code, 3);
  assert.equal(wrongKind.outputs.status, "INVALID_REPORT_OR_EVIDENCE");
  assert.equal(wrongKind.outputs.evidence_sha256, "");
});

test("every declared output is explicit for product, invalid, stale, and execution results", async () => {
  const gateReport = await genuineGateReportJson(passingOffExample, passingOnExample);
  const cases = [
    runAction({ files: { "off.json": OFF }, inputs: { mode: "verify", evidence: "off.json", output_directory: "out" } }),
    runAction({ files: { "off.json": BROKEN_OFF }, inputs: { mode: "verify", evidence: "off.json", output_directory: "out" } }),
    runAction({ files: { "bad.json": "{}" }, inputs: { mode: "verify", evidence: "bad.json", output_directory: "out" } }),
    runAction({ files: { "report.json": gateReport, "off.json": BROKEN_OFF, "on.json": ON }, inputs: { mode: "check", report: "report.json", off_evidence: "off.json", on_evidence: "on.json" } }),
    runAction({ inputs: { mode: "verify", evidence: "missing.json", output_directory: "out" } }),
  ];
  for (const result of cases) assertEveryOutputPresent(result);
  assert.equal(cases[0]!.outputs.mode, "verify");
  assert.equal(cases[1]!.outputs.mode, "verify");
  assert.equal(cases[2]!.outputs.report_json, "");
  assert.equal(cases[3]!.outputs.report_json, "");
  assert.equal(cases[4]!.outputs.report_json, "");
});

function symlinkTestOptions(): { skip?: string } {
  const base = mkdtempSync(path.join(tmpdir(), "pp-symlink-probe-"));
  const target = path.join(base, "target");
  const link = path.join(base, "link");
  writeFileSync(target, "probe");
  const supported = tryCreateFileSymlink(target, link);
  rmSync(base, { recursive: true, force: true });
  return supported ? {} : { skip: "file symlinks are unavailable on this host" };
}

const SYMLINK_TEST = symlinkTestOptions();

for (const [label, inputs, linkName] of [
  ["evidence", { mode: "verify", evidence: "escape.json", output_directory: "out" }, "escape.json"],
  ["report", { mode: "check", report: "escape.json", evidence: "off.json" }, "escape.json"],
  ["OFF", { mode: "gate", off_evidence: "escape.json", on_evidence: "on.json", output_directory: "out" }, "escape.json"],
  ["ON", { mode: "gate", off_evidence: "off.json", on_evidence: "escape.json", output_directory: "out" }, "escape.json"],
] as const) {
  test(`${label} symlink escaping the workspace is rejected without reading its target`, SYMLINK_TEST, () => {
    const result = runAction({
      files: { "off.json": OFF, "on.json": ON },
      inputs,
      setup: (workspace, outside) => {
        const target = path.join(outside, "outside.json");
        writeFileSync(target, label === "report" ? "{}" : OFF);
        assert.ok(tryCreateFileSymlink(target, path.join(workspace, linkName)));
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.status, "EXECUTION_ERROR");
    assert.equal(readFileSync(path.join(result.outside, "outside.json"), "utf8"), label === "report" ? "{}" : OFF);
  });
}

test("an input symlink whose target stays inside the workspace is accepted", SYMLINK_TEST, () => {
  const result = runAction({
    files: { "actual/off.json": OFF },
    inputs: { mode: "verify", evidence: "off-link.json", output_directory: "out" },
    setup: (workspace) => {
      assert.ok(tryCreateFileSymlink(path.join(workspace, "actual/off.json"), path.join(workspace, "off-link.json")));
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.outputs.status, "PASS");
});

test("output directory and parent symlink escapes are rejected", SYMLINK_TEST, () => {
  for (const outputDirectory of ["out-link", "parent-link/nested"]) {
    const result = runAction({
      files: { "off.json": OFF },
      inputs: { mode: "verify", evidence: "off.json", output_directory: outputDirectory },
      setup: (workspace, outside) => {
        const link = path.join(workspace, outputDirectory.split("/")[0]!);
        assert.ok(tryCreateDirectorySymlink(outside, link));
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.status, "EXECUTION_ERROR");
    assert.deepEqual([], requireDirectoryEntries(result.outside));
  }
});

for (const filename of ["report.json", "report.md"] as const) {
  test(`${filename} symlink escape is rejected without changing the outside file`, SYMLINK_TEST, () => {
    const result = runAction({
      files: { "off.json": OFF },
      inputs: { mode: "verify", evidence: "off.json", output_directory: "out" },
      setup: (workspace, outside) => {
        mkdirSync(path.join(workspace, "out"));
        const target = path.join(outside, filename);
        writeFileSync(target, "outside sentinel");
        assert.ok(tryCreateFileSymlink(target, path.join(workspace, "out", filename)));
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.outputs.status, "EXECUTION_ERROR");
    assert.equal(readFileSync(path.join(result.outside, filename), "utf8"), "outside sentinel");
  });
}

test("an output path that is a regular file fails while a valid nested directory succeeds", () => {
  const blocked = runAction({
    files: { "off.json": OFF, out: "not a directory" },
    inputs: { mode: "verify", evidence: "off.json", output_directory: "out" },
  });
  assert.equal(blocked.code, 1);
  assert.equal(blocked.outputs.status, "EXECUTION_ERROR");

  const nested = runAction({
    files: { "off.json": OFF },
    inputs: { mode: "verify", evidence: "off.json", output_directory: "nested/reports" },
  });
  assert.equal(nested.code, 0);
  assert.ok(existsSync(path.join(nested.workspace, "nested/reports/report.json")));
  assert.ok(existsSync(path.join(nested.workspace, "nested/reports/report.md")));
  assert.deepEqual(
    readdirSync(path.join(nested.workspace, "nested/reports")).sort(),
    ["report.json", "report.md"],
  );
});

test("a canonical-path failure cannot present a mixed old/new report pair", () => {
  const result = runAction({
    files: { "off.json": OFF, "out/report.json": "old report" },
    inputs: { mode: "verify", evidence: "off.json", output_directory: "out" },
    setup: (workspace) => mkdirSync(path.join(workspace, "out/report.md")),
  });
  assert.equal(result.code, 1);
  assert.equal(result.outputs.status, "EXECUTION_ERROR");
  assert.equal(result.outputs.report_json, "");
  assert.equal(result.outputs.report_markdown, "");
  assert.ok(!existsSync(path.join(result.workspace, "out/report.json")));
});

function requireDirectoryEntries(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}
