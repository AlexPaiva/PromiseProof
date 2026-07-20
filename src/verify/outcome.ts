export type ExternalOutcome =
  | "PASS"
  | "BROKEN_PROMISE"
  | "INVALID_EVIDENCE"
  | "EXECUTION_ERROR";

export const EXIT_CODE = {
  PASS: 0,
  EXECUTION_ERROR: 1,
  BROKEN_PROMISE: 2,
  INVALID_EVIDENCE: 3,
} as const satisfies Record<ExternalOutcome, number>;

export const SUPPORTED_SCHEMA_VERSION = "1" as const;
export const SUPPORTED_CONTRACT_FAMILY =
  "activity-personalization/v1" as const;
export const REPORT_SCHEMA_VERSION = "1" as const;
