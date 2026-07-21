// PromiseProof Verify GitHub Action entry point.
//
// This is bundled by esbuild into .github/actions/verify/dist/index.js and runs
// as a node20 Action. It reuses the frozen verifier modules and never
// re-implements an evaluator rule. It talks to the Actions runner only through
// the documented environment files (GITHUB_OUTPUT, GITHUB_STEP_SUMMARY) and
// workflow command protocol (::error::, ::warning::). It makes no network
// request, no model call, and reads only the files it is explicitly given.
import { appendFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
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

function emit(kind: "error" | "warning", message: string): void {
  process.stdout.write(`::${kind}::${message.replaceAll("\n", " ")}\n`);
}

function readInput(name: string): string {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

const collectedOutputs: Record<string, string> = {};
function setOutput(name: string, value: string): void {
  collectedOutputs[name] = value;
  const file = process.env.GITHUB_OUTPUT;
  if (file === undefined || file === "") return;
  const delimiter = `ghadelim_${name}_${value.length}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
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
    throw new ActionUsageError(`${label} does not exist: ${relInput}`);
  }
  if (statSync(realpathSync(target)).isDirectory()) {
    throw new ActionUsageError(`${label} is a directory, expected a file: ${relInput}`);
  }
  return target;
}

function resolveOutputDirectory(root: string, relInput: string): string {
  const target = path.resolve(root, relInput);
  assertInsideWorkspace(root, target);
  if (existsSync(target) && !statSync(realpathSync(target)).isDirectory()) {
    throw new ActionUsageError(`output_directory is a file, expected a directory: ${relInput}`);
  }
  mkdirSync(target, { recursive: true });
  return target;
}

async function readJsonFile(absolute: string, relForLog: string, label: string): Promise<unknown> {
  const size = statSync(absolute).size;
  if (size > MAX_INPUT_BYTES) {
    throw new ActionUsageError(`${label} exceeds the ${MAX_INPUT_BYTES}-byte limit: ${relForLog}`);
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

async function writeReports(
  root: string,
  outputDir: string,
  json: string,
  markdown: string,
): Promise<{ jsonRel: string; markdownRel: string }> {
  const jsonPath = path.join(outputDir, "report.json");
  const markdownPath = path.join(outputDir, "report.md");
  await writeFile(jsonPath, json, "utf8");
  await writeFile(markdownPath, markdown, "utf8");
  return { jsonRel: relative(root, jsonPath), markdownRel: relative(root, markdownPath) };
}

async function runVerify(root: string): Promise<Dispatch> {
  const evidencePath = resolveExistingFile(root, readInput("evidence"), "evidence");
  const outputDir = resolveOutputDirectory(root, readInput("output_directory") || "promiseproof-report");
  const evidence = await readJsonFile(evidencePath, relative(root, evidencePath), "evidence");

  const result = verifyBundle(evidence);
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  if (result.outcome === "INVALID_EVIDENCE") {
    setOutput("status", "INVALID_EVIDENCE");
    appendSummary(actionHeader("verify", "INVALID_EVIDENCE"));
    appendSummary("Evidence failed strict validation. No report was produced.");
    for (const issue of result.issues) appendSummary(`- ${issue}`);
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
  appendSummary(serializeVerifyReportMarkdown(report));

  if (report.outcome === "BROKEN_PROMISE") {
    emit("error", "verify: BROKEN_PROMISE. See the report for the failing clauses.");
    return { status: "BROKEN_PROMISE", exitCode: 2 };
  }
  return { status: "PASS", exitCode: 0 };
}

async function runGateMode(root: string): Promise<Dispatch> {
  const offPath = resolveExistingFile(root, readInput("off_evidence"), "off_evidence");
  const onPath = resolveExistingFile(root, readInput("on_evidence"), "on_evidence");
  const outputDir = resolveOutputDirectory(root, readInput("output_directory") || "promiseproof-report");
  const off = await readJsonFile(offPath, relative(root, offPath), "off_evidence");
  const on = await readJsonFile(onPath, relative(root, onPath), "on_evidence");

  const result = runGate(off, on);
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  if (result.outcome === "INVALID_EVIDENCE") {
    setOutput("status", "INVALID_EVIDENCE");
    appendSummary(actionHeader("gate", "INVALID_EVIDENCE"));
    appendSummary("Gate evidence failed strict validation. No report was produced.");
    for (const issue of result.issues) appendSummary(`- ${issue}`);
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
  appendSummary(serializeGateReportMarkdown(report));

  if (report.outcome === "BROKEN_PROMISE") {
    emit("error", "gate: BROKEN_PROMISE. See the report for the failing clauses.");
    return { status: "BROKEN_PROMISE", exitCode: 2 };
  }
  return { status: "PASS", exitCode: 0 };
}

async function runCheck(root: string): Promise<Dispatch> {
  const reportPath = resolveExistingFile(root, readInput("report"), "report");
  const report = await readJsonFile(reportPath, relative(root, reportPath), "report");
  const evidenceInput = readInput("evidence");
  const offInput = readInput("off_evidence");
  const onInput = readInput("on_evidence");
  setOutput("evaluator_sha256", EVALUATOR_SOURCE_SHA256);

  let status: string;
  if (evidenceInput !== "") {
    const evidencePath = resolveExistingFile(root, evidenceInput, "evidence");
    const evidence = await readJsonFile(evidencePath, relative(root, evidencePath), "evidence");
    status = (await checkSingle(report, evidence)).status;
    const derived = verifyBundle(evidence);
    if (derived.outcome !== "INVALID_EVIDENCE") {
      setOutput("evidence_sha256", (await createVerifyReport(derived)).inputBinding.sha256);
    }
  } else {
    const offPath = resolveExistingFile(root, offInput, "off_evidence");
    const onPath = resolveExistingFile(root, onInput, "on_evidence");
    const off = await readJsonFile(offPath, relative(root, offPath), "off_evidence");
    const on = await readJsonFile(onPath, relative(root, onPath), "on_evidence");
    status = (await checkGate(report, off, on)).status;
    const derived = runGate(off, on);
    if (derived.outcome !== "INVALID_EVIDENCE") {
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
  throw new ActionUsageError(`unknown mode: ${mode || "(empty)"}. Expected verify, gate, or check.`);
}

async function main(): Promise<void> {
  let dispatch: Dispatch;
  try {
    const mode = selectMode();
    const root = workspaceRoot();
    setOutput("mode", mode);
    if (mode === "verify") dispatch = await runVerify(root);
    else if (mode === "gate") dispatch = await runGateMode(root);
    else dispatch = await runCheck(root);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setOutput("status", "EXECUTION_ERROR");
    emit("error", `PromiseProof action error: ${message}`);
    appendSummary(actionHeader(readInput("mode") || "unknown", "EXECUTION_ERROR"));
    appendSummary("The action could not complete because of a usage or runtime error.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = dispatch.exitCode;
}

void main();
