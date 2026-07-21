// PromiseProof Verify GitHub Action entry point.
//
// This is bundled by esbuild into .github/actions/verify/dist/index.js and runs
// as a node20 Action. It reuses the frozen verifier modules and never
// re-implements an evaluator rule. It talks to the Actions runner only through
// the documented environment files (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) and
// workflow command protocol (::error::, ::warning::). It makes no network
// request, no model call, and reads only the files it is explicitly given.
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { EVALUATOR_SOURCE_SHA256 } from "../verify/binding.js";
import { checkGate, checkSingle } from "../verify/check.js";
import { MAX_INPUT_BYTES } from "../verify/schema.js";
import { SUPPORTED_CONTRACT_FAMILY } from "../verify/outcome.js";
import {
  createGateReport,
  createVerifyReport,
  serializeGateReportMarkdown,
  serializeReportJson,
  serializeVerifyReportMarkdown,
  type GateReport,
  type VerifyReport,
} from "../verify/report.js";
import { runGate, verifyBundle } from "../verify/verify.js";

const CONTRACT = SUPPORTED_CONTRACT_FAMILY;

// A usage or environment problem, distinct from a product verdict. Exit 1.
class ActionUsageError extends Error {}

class ActionInvalidInputError extends Error {
  constructor(
    readonly status: "INVALID_EVIDENCE" | "INVALID_REPORT_OR_EVIDENCE",
    readonly mode: "verify" | "gate" | "check",
  ) {
    super(
      status === "INVALID_EVIDENCE"
        ? "evidence exceeds the input-size limit"
        : "report or evidence exceeds the input-size limit",
    );
  }
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

const UNSAFE_PATH_CHARACTERS =
  /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;

function workflowCommandValue(message: string): string {
  return message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function emit(kind: "error" | "warning", message: string): void {
  process.stdout.write(`::${kind}::${workflowCommandValue(message)}\n`);
}

function readInput(name: string): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

function readPathInput(name: string): string {
  const raw = process.env[`INPUT_${name.toUpperCase()}`] ?? "";
  if (UNSAFE_PATH_CHARACTERS.test(raw)) {
    throw new ActionUsageError(`${name} contains a forbidden control character.`);
  }
  return raw.trim();
}

const collectedOutputs: Record<string, string> = {};
function setOutput(name: string, value: string): void {
  if (!/^[a-z0-9_]+$/u.test(name)) {
    throw new ActionUsageError("an internal output name is invalid.");
  }
  if (/[\r\n\u0000]/u.test(value)) {
    throw new ActionUsageError(`the ${name} output is not single-line safe.`);
  }
  collectedOutputs[name] = value;
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined || file === "") return;
  appendFileSync(file, `${name}=${value}\n`, "utf8");
}

function initializeOutputs(): void {
  for (const name of OUTPUT_NAMES) {
    setOutput(name, "");
  }
}

function appendSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file === undefined || file === "") return;
  appendFileSync(file, `${markdown}\n`, "utf8");
}

function actionHeader(mode: string, status: string): string {
  return [
    "## PromiseProof Verify",
    "",
    `- mode: ${mode}`,
    `- status: ${status}`,
    `- contract family: ${CONTRACT}`,
    "- no model call in the verdict path",
    "- external evidence collection is not attested",
    "",
  ].join("\n");
}

function appendEvaluationSummary(
  heading: string,
  evaluation: VerifyReport | GateReport["evaluations"]["off"],
): void {
  appendSummary(`### ${heading}`);
  appendSummary("");
  for (const clause of evaluation.clauses) {
    appendSummary(`- ${clause.id}: ${clause.passed ? "PASS" : "FAIL"}`);
  }
  if (evaluation.violations.length > 0) {
    appendSummary(
      `- violation codes: ${evaluation.violations.map((item) => item.code).join(", ")}`,
    );
  }
}

// ---- path safety: everything must resolve inside GITHUB_WORKSPACE ----
function workspaceRoot(): string {
  const raw = process.env.GITHUB_WORKSPACE;
  if (raw === undefined || raw === "") {
    throw new ActionUsageError("GITHUB_WORKSPACE is not set.");
  }
  if (!existsSync(raw)) {
    throw new ActionUsageError("GITHUB_WORKSPACE does not exist.");
  }
  return realpathSync(raw);
}

// Resolve the nearest existing ancestor through realpath and require that it is
// contained by the workspace. This catches absolute escapes, `..` traversal,
// and symlinks whose target leaves the workspace, for existing and not-yet
// created paths alike.
function assertInsideWorkspace(root: string, target: string): void {
  let probe = target;
  while (!existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = existsSync(probe) ? realpathSync(probe) : probe;
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new ActionUsageError("a path resolves outside the workspace.");
  }
}

function resolveExistingFile(root: string, relInput: string, label: string): string {
  if (relInput === "") {
    throw new ActionUsageError(`${label} is required but was empty.`);
  }
  const target = path.resolve(root, relInput);
  assertInsideWorkspace(root, target);
  if (!existsSync(target)) {
    throw new ActionUsageError(`${label} does not exist.`);
  }
  const canonical = realpathSync(target);
  assertInsideWorkspace(root, canonical);
  if (!statSync(canonical).isFile()) {
    throw new ActionUsageError(`${label} is not a regular file.`);
  }
  return canonical;
}

function resolveOutputDirectory(root: string, relInput: string): string {
  const target = path.resolve(root, relInput);
  assertInsideWorkspace(root, target);
  if (existsSync(target) && !statSync(realpathSync(target)).isDirectory()) {
    throw new ActionUsageError("output_directory is a file, expected a directory.");
  }
  mkdirSync(target, { recursive: true });
  const canonical = realpathSync(target);
  assertInsideWorkspace(root, canonical);
  return canonical;
}

async function readJsonFile(
  absolute: string,
  label: string,
  invalidStatus: "INVALID_EVIDENCE" | "INVALID_REPORT_OR_EVIDENCE",
  mode: "verify" | "gate" | "check",
): Promise<unknown> {
  const size = statSync(absolute).size;
  if (size > MAX_INPUT_BYTES) {
    throw new ActionInvalidInputError(invalidStatus, mode);
  }
  const text = await readFile(absolute, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A malformed JSON file is treated as invalid evidence, not a crash; the
    // caller maps that to the right product outcome.
    return { __promiseproofMalformedJson: true };
  }
}

function relative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join("/");
}

interface Dispatch {
  status: string;
  exitCode: number;
}

function canonicalReportPaths(outputDir: string): {
  jsonPath: string;
  markdownPath: string;
} {
  return {
    jsonPath: path.join(outputDir, "report.json"),
    markdownPath: path.join(outputDir, "report.md"),
  };
}

function assertSafeCanonicalTarget(root: string, target: string): void {
  assertInsideWorkspace(root, target);
  if (!existsSync(target)) return;
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) {
    throw new ActionUsageError("a canonical report path is a symbolic link.");
  }
  if (!entry.isFile()) {
    throw new ActionUsageError("a canonical report path is not a regular file.");
  }
}

async function removeCanonicalReport(root: string, target: string): Promise<void> {
  assertSafeCanonicalTarget(root, target);
  if (existsSync(target)) await unlink(target);
}

async function clearCanonicalReports(root: string, outputDir: string): Promise<void> {
  const { jsonPath, markdownPath } = canonicalReportPaths(outputDir);
  await removeCanonicalReport(root, jsonPath);
  await removeCanonicalReport(root, markdownPath);
}

async function writeExclusiveFile(target: string, content: string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeGeneratedFile(root: string, target: string): Promise<void> {
  if (!existsSync(target)) return;
  try {
    assertSafeCanonicalTarget(root, target);
    await unlink(target);
  } catch {
    // Preserve the original write failure. Never follow or remove an unsafe
    // replacement installed concurrently at a canonical output path.
  }
}

async function writeReports(
  root: string,
  outputDir: string,
  json: string,
  markdown: string,
): Promise<{ jsonRel: string; markdownRel: string }> {
  assertInsideWorkspace(root, realpathSync(outputDir));
  const { jsonPath, markdownPath } = canonicalReportPaths(outputDir);
  const nonce = randomUUID();
  const jsonTemp = path.join(outputDir, `.promiseproof-${nonce}.json.tmp`);
  const markdownTemp = path.join(outputDir, `.promiseproof-${nonce}.md.tmp`);
  let jsonInstalled = false;
  let markdownInstalled = false;

  try {
    await writeExclusiveFile(jsonTemp, json);
    await writeExclusiveFile(markdownTemp, markdown);

    assertInsideWorkspace(root, realpathSync(outputDir));
    assertSafeCanonicalTarget(root, jsonPath);
    assertSafeCanonicalTarget(root, markdownPath);
    if (existsSync(jsonPath) || existsSync(markdownPath)) {
      throw new ActionUsageError("a canonical report path changed during report creation.");
    }

    await rename(jsonTemp, jsonPath);
    jsonInstalled = true;
    assertInsideWorkspace(root, realpathSync(outputDir));
    assertSafeCanonicalTarget(root, markdownPath);
    if (existsSync(markdownPath)) {
      throw new ActionUsageError("a canonical report path changed during report creation.");
    }
    await rename(markdownTemp, markdownPath);
    markdownInstalled = true;

    assertSafeCanonicalTarget(root, jsonPath);
    assertSafeCanonicalTarget(root, markdownPath);
    return { jsonRel: relative(root, jsonPath), markdownRel: relative(root, markdownPath) };
  } catch (error) {
    if (jsonInstalled) await removeGeneratedFile(root, jsonPath);
    if (markdownInstalled) await removeGeneratedFile(root, markdownPath);
    throw error;
  } finally {
    if (existsSync(jsonTemp)) await unlink(jsonTemp).catch(() => undefined);
    if (existsSync(markdownTemp)) await unlink(markdownTemp).catch(() => undefined);
  }
}

async function runVerify(root: string): Promise<Dispatch> {
  const evidenceInput = readPathInput("evidence");
  const outputInput = readPathInput("output_directory") || "promiseproof-report";
  const evidencePath = resolveExistingFile(root, evidenceInput, "evidence");
  const outputDir = resolveOutputDirectory(
    root,
    outputInput,
  );
  await clearCanonicalReports(root, outputDir);
  const evidence = await readJsonFile(
    evidencePath,
    "evidence",
    "INVALID_EVIDENCE",
    "verify",
  );

  const result = verifyBundle(evidence);
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  if (result.outcome === "INVALID_EVIDENCE") {
    setOutput("status", "INVALID_EVIDENCE");
    appendSummary(actionHeader("verify", "INVALID_EVIDENCE"));
    appendSummary("Evidence failed strict validation. No report was produced.");
    appendSummary(`Validation issue count: ${result.issues.length}.`);
    emit("error", "verify: evidence failed strict validation.");
    return { status: "INVALID_EVIDENCE", exitCode: 3 };
  }

  const report: VerifyReport = await createVerifyReport(result);
  const { jsonRel, markdownRel } = await writeReports(
    root,
    outputDir,
    serializeReportJson(report),
    serializeVerifyReportMarkdown(report),
  );
  setOutput("report_json", jsonRel);
  setOutput("report_markdown", markdownRel);
  setOutput("evidence_sha256", report.inputBinding.sha256);
  setOutput("status", report.outcome);
  appendSummary(actionHeader("verify", report.outcome));
  appendEvaluationSummary("Deterministic evaluation", report);
  appendSummary("Complete evidence-bound JSON and Markdown reports were written to the declared output paths.");

  if (report.outcome === "BROKEN_PROMISE") {
    emit("error", "verify: BROKEN_PROMISE. See the report for the failing clauses.");
    return { status: "BROKEN_PROMISE", exitCode: 2 };
  }
  return { status: "PASS", exitCode: 0 };
}

async function runGateMode(root: string): Promise<Dispatch> {
  const offInput = readPathInput("off_evidence");
  const onInput = readPathInput("on_evidence");
  const outputInput = readPathInput("output_directory") || "promiseproof-report";
  const offPath = resolveExistingFile(root, offInput, "off_evidence");
  const onPath = resolveExistingFile(root, onInput, "on_evidence");
  const outputDir = resolveOutputDirectory(
    root,
    outputInput,
  );
  await clearCanonicalReports(root, outputDir);
  const off = await readJsonFile(offPath, "off_evidence", "INVALID_EVIDENCE", "gate");
  const on = await readJsonFile(onPath, "on_evidence", "INVALID_EVIDENCE", "gate");

  const result = runGate(off, on);
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  if (result.outcome === "INVALID_EVIDENCE") {
    setOutput("status", "INVALID_EVIDENCE");
    appendSummary(actionHeader("gate", "INVALID_EVIDENCE"));
    appendSummary("Gate evidence failed strict validation. No report was produced.");
    appendSummary(`Validation issue count: ${result.issues.length}.`);
    emit("error", "gate: evidence failed strict validation.");
    return { status: "INVALID_EVIDENCE", exitCode: 3 };
  }

  const report: GateReport = await createGateReport(result);
  const { jsonRel, markdownRel } = await writeReports(
    root,
    outputDir,
    serializeReportJson(report),
    serializeGateReportMarkdown(report),
  );
  setOutput("report_json", jsonRel);
  setOutput("report_markdown", markdownRel);
  setOutput("off_evidence_sha256", report.inputBindings.off.sha256);
  setOutput("on_evidence_sha256", report.inputBindings.on.sha256);
  setOutput("status", report.outcome);
  appendSummary(actionHeader("gate", report.outcome));
  appendEvaluationSummary("OFF evaluation", report.evaluations.off);
  appendEvaluationSummary("ON evaluation", report.evaluations.on);
  appendSummary("Complete evidence-bound JSON and Markdown reports were written to the declared output paths.");

  if (report.outcome === "BROKEN_PROMISE") {
    emit("error", "gate: BROKEN_PROMISE. See the report for the failing clauses.");
    return { status: "BROKEN_PROMISE", exitCode: 2 };
  }
  return { status: "PASS", exitCode: 0 };
}

async function runCheck(root: string): Promise<Dispatch> {
  const reportInput = readPathInput("report");
  const evidenceInput = readPathInput("evidence");
  const offInput = readPathInput("off_evidence");
  const onInput = readPathInput("on_evidence");
  const reportPath = resolveExistingFile(root, reportInput, "report");
  const report = await readJsonFile(
    reportPath,
    "report",
    "INVALID_REPORT_OR_EVIDENCE",
    "check",
  );
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  let status: string;
  if (evidenceInput !== "") {
    const evidencePath = resolveExistingFile(root, evidenceInput, "evidence");
    const evidence = await readJsonFile(
      evidencePath,
      "evidence",
      "INVALID_REPORT_OR_EVIDENCE",
      "check",
    );
    status = (await checkSingle(report, evidence)).status;
    if (status !== "INVALID_REPORT_OR_EVIDENCE") {
      const derived = verifyBundle(evidence);
      setOutput("evidence_sha256", (await createVerifyReport(derived)).inputBinding.sha256);
    }
  } else {
    const offPath = resolveExistingFile(root, offInput, "off_evidence");
    const onPath = resolveExistingFile(root, onInput, "on_evidence");
    const off = await readJsonFile(
      offPath,
      "off_evidence",
      "INVALID_REPORT_OR_EVIDENCE",
      "check",
    );
    const on = await readJsonFile(
      onPath,
      "on_evidence",
      "INVALID_REPORT_OR_EVIDENCE",
      "check",
    );
    status = (await checkGate(report, off, on)).status;
    if (status !== "INVALID_REPORT_OR_EVIDENCE") {
      const derived = runGate(off, on);
      const derivedReport = await createGateReport(derived);
      setOutput("off_evidence_sha256", derivedReport.inputBindings.off.sha256);
      setOutput("on_evidence_sha256", derivedReport.inputBindings.on.sha256);
    }
  }

  setOutput("status", status);
  appendSummary(actionHeader("check", status));
  appendSummary(`Reproduction result: **${status}**.`);
  appendSummary(`Evaluator source SHA-256: \`${EVALUATOR_SOURCE_SHA256}\`.`);

  if (status === "BOUND_AND_REPRODUCED") return { status, exitCode: 0 };
  if (status === "STALE_OR_MISMATCH") {
    emit("error", "check: STALE_OR_MISMATCH. The report does not reproduce from the evidence.");
    return { status, exitCode: 4 };
  }
  emit("error", "check: INVALID_REPORT_OR_EVIDENCE.");
  return { status, exitCode: 3 };
}

// Strict mode + input-combination validation before any evidence is read.
function selectMode(): "verify" | "gate" | "check" {
  const mode = readInput("mode");
  const evidence = readInput("evidence") !== "";
  const off = readInput("off_evidence") !== "";
  const on = readInput("on_evidence") !== "";
  const report = readInput("report") !== "";

  if (mode === "verify") {
    if (!evidence) throw new ActionUsageError("verify requires evidence.");
    if (report || off || on) {
      throw new ActionUsageError("verify accepts only evidence, not report/off_evidence/on_evidence.");
    }
    return "verify";
  }
  if (mode === "gate") {
    if (!off || !on) throw new ActionUsageError("gate requires off_evidence and on_evidence.");
    if (report || evidence) {
      throw new ActionUsageError("gate accepts only off_evidence and on_evidence.");
    }
    return "gate";
  }
  if (mode === "check") {
    if (!report) throw new ActionUsageError("check requires report.");
    const single = evidence && !off && !on;
    const gate = off && on && !evidence;
    if (!single && !gate) {
      throw new ActionUsageError("check requires report with either evidence, or both off_evidence and on_evidence.");
    }
    return "check";
  }
  throw new ActionUsageError("unknown mode. Expected verify, gate, or check.");
}

async function main(): Promise<void> {
  let dispatch: Dispatch;
  let resolvedMode: "verify" | "gate" | "check" | null = null;
  try {
    initializeOutputs();
    const mode = selectMode();
    resolvedMode = mode;
    const root = workspaceRoot();
    setOutput("mode", mode);
    if (mode === "verify") dispatch = await runVerify(root);
    else if (mode === "gate") dispatch = await runGateMode(root);
    else dispatch = await runCheck(root);
  } catch (error) {
    if (error instanceof ActionInvalidInputError) {
      setOutput("status", error.status);
      appendSummary(actionHeader(error.mode, error.status));
      appendSummary(
        error.status === "INVALID_EVIDENCE"
          ? "Evidence exceeded the strict input-size limit. No report was produced."
          : "A report or evidence file exceeded the strict input-size limit.",
      );
      emit("error", `${error.mode}: ${error.status}.`);
      process.exitCode = 3;
      return;
    }
    const message =
      error instanceof ActionUsageError
        ? error.message
        : "an unexpected execution failure occurred.";
    setOutput("status", "EXECUTION_ERROR");
    emit("error", `PromiseProof action error: ${message}`);
    appendSummary(actionHeader(resolvedMode ?? "unknown", "EXECUTION_ERROR"));
    appendSummary("The action could not complete because of a usage or runtime error.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = dispatch.exitCode;
}

void main();
