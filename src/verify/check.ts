// Reproducible report check. A bound report is only trustworthy if it can be
// REPRODUCED: re-run the unchanged evaluator on the supplied evidence, regenerate
// the complete report, and compare the whole canonical document. Comparing only
// the embedded hashes is insufficient, a fabricated report could carry the correct
// evidence digest and evaluator fingerprint while inventing the verdict, clauses,
// or violations. Full reproduction catches that.
import { z } from "zod";
import {
  CANONICAL_JSON_ID,
  canonicalizeJson,
  SHA256_ALGORITHM,
} from "./binding.js";
import {
  REPORT_SCHEMA_VERSION,
  SUPPORTED_CONTRACT_FAMILY,
} from "./outcome.js";
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

const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const inputBindingSchema = z
  .object({
    canonicalization: z.literal(CANONICAL_JSON_ID),
    algorithm: z.literal(SHA256_ALGORITHM),
    sha256,
  })
  .strict();
const clauseIdSchema = z.enum([
  "no_identifiable_activity",
  "contextual_feed_functional",
  "preference_survives_reload",
  "expected_activity_received",
  "behavioral_feed_functional",
]);
const violationCodeSchema = z.enum([
  "PP_IDENTIFIABLE_EVENT_LEAK",
  "PP_CONTEXTUAL_FEED_MISSING",
  "PP_PREFERENCE_NOT_PERSISTED",
  "PP_EXPECTED_ACTIVITY_MISSING",
  "PP_BEHAVIORAL_FEED_MISSING",
]);
const clauseSchema = z
  .object({
    id: clauseIdSchema,
    passed: z.boolean(),
    expected: z.string(),
    observed: z.string(),
  })
  .strict();
const violationSchema = z
  .object({
    code: violationCodeSchema,
    clause: clauseIdSchema,
    message: z.string(),
  })
  .strict();
const evaluationShape = {
  scenario: z.enum(["off", "on"]),
  canonicalVerdict: z.enum(["pass", "fail"]),
  clauses: z.array(clauseSchema),
  violations: z.array(violationSchema),
} as const;
const authoritySchema = z
  .object({
    evidenceSource: z.string(),
    collectionAttested: z.boolean(),
    evaluation: z.string(),
    evaluatorSourceSha256: sha256,
  })
  .strict();
const reportHeaderShape = {
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  contractFamily: z.literal(SUPPORTED_CONTRACT_FAMILY),
  outcome: z.enum(["PASS", "BROKEN_PROMISE"]),
} as const;

// Report parsing validates only the versioned public report structure. Values
// that are structurally valid but forged (for example, a valid-shaped PASS over
// broken evidence or a different valid-shaped evaluator fingerprint) proceed to
// full reproduction and become STALE_OR_MISMATCH. They are not mistaken for a
// malformed report.
const verifyReportSchema = z
  .object({
    ...reportHeaderShape,
    inputBinding: inputBindingSchema,
    ...evaluationShape,
    authority: authoritySchema,
  })
  .strict();
const gateReportSchema = z
  .object({
    ...reportHeaderShape,
    inputBindings: z
      .object({ off: inputBindingSchema, on: inputBindingSchema })
      .strict(),
    evaluations: z
      .object({
        off: z.object(evaluationShape).strict(),
        on: z.object(evaluationShape).strict(),
      })
      .strict(),
    authority: authoritySchema,
  })
  .strict();

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
  if (!verifyReportSchema.safeParse(rawReport).success) {
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
  if (!gateReportSchema.safeParse(rawReport).success) {
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
