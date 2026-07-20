// Reproducible report check. A bound report is only trustworthy if it can be
// REPRODUCED: re-run the unchanged evaluator on the supplied evidence, regenerate
// the complete report, and compare the whole canonical document. Comparing only
// the embedded hashes is insufficient, a fabricated report could carry the correct
// evidence digest and evaluator fingerprint while inventing the verdict, clauses,
// or violations. Full reproduction catches that.
import { z } from "zod";
import { canonicalizeJson } from "./binding.js";
import { REPORT_SCHEMA_VERSION } from "./outcome.js";
import { createGateReport, createVerifyReport } from "./report.js";
import { runGate, verifyBundle } from "./verify.js";

export const CHECK_EXIT = {
  BOUND_AND_REPRODUCED: 0,
  USAGE_OR_EXECUTION_ERROR: 1,
  INVALID_REPORT_OR_EVIDENCE: 3,
  STALE_OR_MISMATCH: 4,
} as const;

export type CheckStatus = keyof typeof CHECK_EXIT;

export interface CheckResult {
  readonly status: CheckStatus;
  readonly detail: string;
}

// Minimal envelope: the supplied document must at least declare itself a report
// of the current schema version to be checkable. Anything else is INVALID (not a
// mere mismatch); a well-formed report that fails to reproduce is a mismatch.
const reportEnvelope = z
  .object({ schemaVersion: z.literal(REPORT_SCHEMA_VERSION) })
  .passthrough();

function invalid(detail: string): CheckResult {
  return { status: "INVALID_REPORT_OR_EVIDENCE", detail };
}

function compare(regenerated: unknown, supplied: unknown): CheckResult {
  if (canonicalizeJson(regenerated) === canonicalizeJson(supplied)) {
    return {
      status: "BOUND_AND_REPRODUCED",
      detail:
        "the report is reproduced exactly by re-running the unchanged evaluator on the supplied evidence",
    };
  }
  return {
    status: "STALE_OR_MISMATCH",
    detail:
      "the supplied report does not match the report reproduced from the supplied evidence",
  };
}

export async function checkSingle(
  rawReport: unknown,
  rawEvidence: unknown,
): Promise<CheckResult> {
  if (!reportEnvelope.safeParse(rawReport).success) {
    return invalid(
      `report is not a schemaVersion ${REPORT_SCHEMA_VERSION} verification report`,
    );
  }
  const result = verifyBundle(rawEvidence);
  if (result.outcome === "INVALID_EVIDENCE") {
    return invalid(
      "evidence is invalid; no canonical report can be reproduced from it",
    );
  }
  return compare(await createVerifyReport(result), rawReport);
}

export async function checkGate(
  rawReport: unknown,
  rawOff: unknown,
  rawOn: unknown,
): Promise<CheckResult> {
  if (!reportEnvelope.safeParse(rawReport).success) {
    return invalid(
      `report is not a schemaVersion ${REPORT_SCHEMA_VERSION} gate report`,
    );
  }
  const result = runGate(rawOff, rawOn);
  if (result.outcome === "INVALID_EVIDENCE") {
    return invalid(
      "gate evidence is invalid; no canonical report can be reproduced from it",
    );
  }
  return compare(await createGateReport(result), rawReport);
}
