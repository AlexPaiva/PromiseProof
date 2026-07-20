import { evaluatePromise } from "../shared/evaluator.js";
import type {
  PromiseEvaluation,
  PromiseEvidence,
} from "../shared/types.js";
import { adaptExternalEvidence } from "./adapter.js";
import {
  SUPPORTED_CONTRACT_FAMILY,
  type ExternalOutcome,
} from "./outcome.js";
import {
  externalBundleSchema,
  type ExternalBundle,
} from "./schema.js";

type CanonicalEvaluator = (evidence: PromiseEvidence) => PromiseEvaluation;

export interface VerifyResult {
  readonly outcome: Exclude<ExternalOutcome, "EXECUTION_ERROR">;
  readonly contractFamily: string;
  readonly scenario: "on" | "off" | null;
  readonly evaluation: PromiseEvaluation | null;
  readonly issues: readonly string[];
}

interface ValidatedBundle {
  readonly success: true;
  readonly bundle: ExternalBundle;
}

interface RejectedBundle {
  readonly success: false;
  readonly issues: readonly string[];
}

type BundleValidation = ValidatedBundle | RejectedBundle;

function issuePath(path: PropertyKey[]): string {
  if (path.length === 0) {
    return "<root>";
  }

  return path.map((part) => String(part)).join(".");
}

export function validateExternalBundle(raw: unknown): BundleValidation {
  const parsed = externalBundleSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues
        .map((issue) => `${issuePath(issue.path)}: ${issue.message}`)
        .sort(),
    };
  }

  return {
    success: true,
    bundle: parsed.data,
  };
}

function rejectedResult(validation: BundleValidation): VerifyResult {
  return {
    outcome: "INVALID_EVIDENCE",
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    scenario: validation.success ? validation.bundle.evidence.scenario : null,
    evaluation: null,
    issues: [...(validation.success ? [] : validation.issues)].sort(),
  };
}

function evaluateValidatedBundle(
  validated: ValidatedBundle,
  evaluator: CanonicalEvaluator,
): VerifyResult {
  const evidence = adaptExternalEvidence(validated.bundle.evidence);
  const evaluation = evaluator(evidence);
  return {
    outcome: evaluation.verdict === "pass" ? "PASS" : "BROKEN_PROMISE",
    contractFamily: validated.bundle.contractFamily,
    scenario: validated.bundle.evidence.scenario,
    evaluation,
    issues: [],
  };
}

function verifyBundleWithEvaluator(
  raw: unknown,
  evaluator: CanonicalEvaluator,
): VerifyResult {
  const validated = validateExternalBundle(raw);
  if (!validated.success) {
    return rejectedResult(validated);
  }
  return evaluateValidatedBundle(validated, evaluator);
}

export function verifyBundle(raw: unknown): VerifyResult {
  return verifyBundleWithEvaluator(raw, evaluatePromise);
}

export interface GateResult {
  readonly outcome: Exclude<ExternalOutcome, "EXECUTION_ERROR">;
  readonly contractFamily: string;
  readonly off: VerifyResult;
  readonly on: VerifyResult;
  readonly issues: readonly string[];
}

function runGateWithEvaluator(
  rawOff: unknown,
  rawOn: unknown,
  evaluator: CanonicalEvaluator,
): GateResult {
  const validatedOff = validateExternalBundle(rawOff);
  const validatedOn = validateExternalBundle(rawOn);
  const gateIssues: string[] = [];
  const offSlotIssues: string[] = [];
  const onSlotIssues: string[] = [];

  if (
    validatedOff.success &&
    validatedOff.bundle.evidence.scenario !== "off"
  ) {
    offSlotIssues.push("--off bundle must contain OFF-scenario evidence");
  }
  if (
    validatedOn.success &&
    validatedOn.bundle.evidence.scenario !== "on"
  ) {
    onSlotIssues.push("--on bundle must contain ON-scenario evidence");
  }

  gateIssues.push(...offSlotIssues, ...onSlotIssues);
  if (
    !validatedOff.success ||
    !validatedOn.success ||
    gateIssues.length > 0
  ) {
    const off = rejectedResult(validatedOff);
    const on = rejectedResult(validatedOn);
    return {
      outcome: "INVALID_EVIDENCE",
      contractFamily: SUPPORTED_CONTRACT_FAMILY,
      off,
      on,
      issues: [
        ...gateIssues,
        ...off.issues.map((issue) => `off.${issue}`),
        ...on.issues.map((issue) => `on.${issue}`),
      ].sort(),
    };
  }

  const off = evaluateValidatedBundle(validatedOff, evaluator);
  const on = evaluateValidatedBundle(validatedOn, evaluator);
  return {
    outcome:
      off.outcome === "PASS" && on.outcome === "PASS"
        ? "PASS"
        : "BROKEN_PROMISE",
    contractFamily: SUPPORTED_CONTRACT_FAMILY,
    off,
    on,
    issues: [],
  };
}

export function runGate(rawOff: unknown, rawOn: unknown): GateResult {
  return runGateWithEvaluator(rawOff, rawOn, evaluatePromise);
}

export const verifierTestHooks = Object.freeze({
  runGateWithEvaluator,
});

export function gateValidationIssues(result: GateResult): string[] {
  return [...result.issues];
}
