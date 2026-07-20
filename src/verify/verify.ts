import { evaluatePromise } from "../shared/evaluator.js";
import type {
  PromiseEvaluation,
  PromiseEvidence,
} from "../shared/types.js";
import {
  SUPPORTED_CONTRACT_FAMILY,
  type ExternalOutcome,
} from "./outcome.js";
import { externalBundleSchema } from "./schema.js";

export interface VerifyResult {
  readonly outcome: Exclude<ExternalOutcome, "EXECUTION_ERROR">;
  readonly contractFamily: string;
  readonly scenario: "on" | "off" | null;
  readonly evaluation: PromiseEvaluation | null;
  readonly issues: readonly string[];
}

function issuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }

  return path.map((part) => String(part)).join(".");
}

export function verifyBundle(raw: unknown): VerifyResult {
  const parsed = externalBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      outcome: "INVALID_EVIDENCE",
      contractFamily: SUPPORTED_CONTRACT_FAMILY,
      scenario: null,
      evaluation: null,
      issues: parsed.error.issues
        .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
        .sort(),
    };
  }

  const evidence: PromiseEvidence = parsed.data.evidence;
  const evaluation = evaluatePromise(evidence);
  return {
    outcome: evaluation.verdict === "pass" ? "PASS" : "BROKEN_PROMISE",
    contractFamily: parsed.data.contractFamily,
    scenario: evidence.scenario,
    evaluation,
    issues: [],
  };
}

export interface GateResult {
  readonly outcome: Exclude<ExternalOutcome, "EXECUTION_ERROR">;
  readonly contractFamily: string;
  readonly off: VerifyResult;
  readonly on: VerifyResult;
  readonly issues: readonly string[];
}

export function runGate(rawOff: unknown, rawOn: unknown): GateResult {
  const off = verifyBundle(rawOff);
  const on = verifyBundle(rawOn);
  const issues: string[] = [];

  if (off.outcome !== "INVALID_EVIDENCE" && off.scenario !== "off") {
    issues.push("--off bundle must contain OFF-scenario evidence");
  }
  if (on.outcome !== "INVALID_EVIDENCE" && on.scenario !== "on") {
    issues.push("--on bundle must contain ON-scenario evidence");
  }

  let outcome: GateResult["outcome"];
  if (
    off.outcome === "INVALID_EVIDENCE" ||
    on.outcome === "INVALID_EVIDENCE" ||
    issues.length > 0
  ) {
    outcome = "INVALID_EVIDENCE";
  } else if (off.outcome === "PASS" && on.outcome === "PASS") {
    outcome = "PASS";
  } else {
    outcome = "BROKEN_PROMISE";
  }

  return {
    outcome,
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    off,
    on,
    issues: issues.sort(),
  };
}

export function gateValidationIssues(result: GateResult): string[] {
  return [
    ...result.issues,
    ...result.off.issues.map((issue) => `off.${issue}`),
    ...result.on.issues.map((issue) => `on.${issue}`),
  ].sort();
}
