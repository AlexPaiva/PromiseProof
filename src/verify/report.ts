import type {
  PromiseClauseResult,
  PromiseEvaluation,
  PromiseViolation,
} from "../shared/types.js";
import {
  bindCanonicalJson,
  CANONICAL_JSON_ID,
  EVALUATOR_SOURCE_SHA256,
  SHA256_ALGORITHM,
  type InputBinding,
} from "./binding.js";
import {
  REPORT_SCHEMA_VERSION,
  SUPPORTED_CONTRACT_FAMILY,
} from "./outcome.js";
import type { GateResult, VerifyResult } from "./verify.js";

const authority = {
  evidenceSource: "externally-supplied",
  collectionAttested: false,
  evaluation: "deterministic-promiseproof-evaluator",
  evaluatorSourceSha256: EVALUATOR_SOURCE_SHA256,
} as const;

export interface EvaluationReport {
  readonly scenario: "on" | "off";
  readonly canonicalVerdict: "pass" | "fail";
  readonly clauses: readonly PromiseClauseResult[];
  readonly violations: readonly PromiseViolation[];
}

export interface VerifyReport extends EvaluationReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly contractFamily: typeof SUPPORTED_CONTRACT_FAMILY;
  readonly outcome: "PASS" | "BROKEN_PROMISE";
  readonly inputBinding: InputBinding;
  readonly authority: typeof authority;
}

export interface GateReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly contractFamily: typeof SUPPORTED_CONTRACT_FAMILY;
  readonly outcome: "PASS" | "BROKEN_PROMISE";
  readonly inputBindings: {
    readonly off: InputBinding;
    readonly on: InputBinding;
  };
  readonly evaluations: {
    readonly off: EvaluationReport;
    readonly on: EvaluationReport;
  };
  readonly authority: typeof authority;
}

function requireEvaluation(result: VerifyResult): PromiseEvaluation {
  if (result.evaluation === null) {
    throw new Error("Cannot render a canonical report for invalid evidence.");
  }
  return result.evaluation;
}

function requireValidatedCanonicalJson(result: VerifyResult): string {
  if (result.validatedCanonicalJson === null) {
    throw new Error("Cannot bind a report without validated evidence.");
  }
  return result.validatedCanonicalJson;
}

function evaluationReport(result: VerifyResult): EvaluationReport {
  const evaluation = requireEvaluation(result);
  if (result.scenario === null) {
    throw new Error("Evaluated evidence is missing its scenario.");
  }

  return {
    scenario: result.scenario,
    canonicalVerdict: evaluation.verdict,
    clauses: evaluation.clauses.map((clause) => ({ ...clause })),
    violations: evaluation.violations.map((violation) => ({ ...violation })),
  };
}

export async function createVerifyReport(
  result: VerifyResult,
): Promise<VerifyReport> {
  if (
    result.outcome !== "PASS" &&
    result.outcome !== "BROKEN_PROMISE"
  ) {
    throw new Error("Invalid evidence cannot be rendered as a product verdict.");
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    outcome: result.outcome,
    inputBinding: await bindCanonicalJson(
      requireValidatedCanonicalJson(result),
    ),
    ...evaluationReport(result),
    authority,
  };
}

export async function createGateReport(result: GateResult): Promise<GateReport> {
  if (
    result.outcome !== "PASS" &&
    result.outcome !== "BROKEN_PROMISE"
  ) {
    throw new Error("Invalid gate input cannot be rendered as a product verdict.");
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    outcome: result.outcome,
    inputBindings: {
      off: await bindCanonicalJson(requireValidatedCanonicalJson(result.off)),
      on: await bindCanonicalJson(requireValidatedCanonicalJson(result.on)),
    },
    evaluations: {
      off: evaluationReport(result.off),
      on: evaluationReport(result.on),
    },
    authority,
  };
}

export function serializeReportJson(
  report: VerifyReport | GateReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function markdownInline(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", " ")
    .replaceAll("\n", " ")
    .replaceAll("\r", " ");
}

function evaluationMarkdown(
  heading: string,
  report: EvaluationReport,
): string[] {
  const lines = [
    `## ${heading}`,
    "",
    `Scenario: ${report.scenario.toUpperCase()}`,
    `Canonical verdict: ${report.canonicalVerdict}`,
    "",
    "| Clause | Result | Expected | Observed |",
    "| --- | --- | --- | --- |",
    ...report.clauses.map(
      (clause) =>
        `| ${clause.id} | ${clause.passed ? "PASS" : "FAIL"} | ${markdownInline(clause.expected)} | ${markdownInline(clause.observed)} |`,
    ),
    "",
    "### Violations",
    "",
  ];

  if (report.violations.length === 0) {
    lines.push("None.");
  } else {
    lines.push(
      ...report.violations.map(
        (violation) =>
          `- ${violation.code} (${violation.clause}): ${markdownInline(violation.message)}`,
      ),
    );
  }

  return lines;
}

function authorityMarkdown(): string[] {
  return [
    "## Authority",
    "",
    "Evidence source: externally supplied",
    "Collection integrity: not attested by PromiseProof",
    "Evaluation authority: deterministic PromiseProof evaluator",
    `Evaluator source SHA-256 (canonical UTF-8/LF): ${EVALUATOR_SOURCE_SHA256}`,
  ];
}

function inputBindingMarkdown(label: string, binding: InputBinding): string[] {
  return [
    `${label} canonicalization: ${CANONICAL_JSON_ID}`,
    `${label} digest algorithm: ${SHA256_ALGORITHM}`,
    `${label} evidence SHA-256: ${binding.sha256}`,
  ];
}

export function serializeVerifyReportMarkdown(report: VerifyReport): string {
  return [
    "# PromiseProof verification report",
    "",
    `Contract family: ${report.contractFamily}`,
    `Outcome: ${report.outcome}`,
    "",
    ...inputBindingMarkdown("Input", report.inputBinding),
    "",
    ...evaluationMarkdown("Evaluation", report),
    "",
    ...authorityMarkdown(),
    "",
  ].join("\n");
}
export function serializeGateReportMarkdown(report: GateReport): string {
  return [
    "# PromiseProof OFF + ON gate report",
    "",
    `Contract family: ${report.contractFamily}`,
    `Outcome: ${report.outcome}`,
    "",
    ...inputBindingMarkdown("OFF input", report.inputBindings.off),
    ...inputBindingMarkdown("ON input", report.inputBindings.on),
    "",
    ...evaluationMarkdown("OFF evaluation", report.evaluations.off),
    "",
    ...evaluationMarkdown("ON evaluation", report.evaluations.on),
    "",
    ...authorityMarkdown(),
    "",
  ].join("\n");
}
