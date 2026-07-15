import { z } from 'zod';

export const CODEX_REPAIR_MODEL = 'gpt-5.6-sol' as const;
export const CODEX_REPAIR_SDK_VERSION = '0.144.4' as const;
export const CODEX_REPAIR_CLI_VERSION = '0.144.4' as const;
export const CODEX_REPAIR_LOGIN_SHELL_ALLOWED = false as const;
export const CODEX_REPAIR_WINDOWS_SANDBOX = 'elevated' as const;
export const CODEX_REPAIR_PROMPT_VERSION =
  'promiseproof.codex-repair-prompt.v3' as const;
export const CODEX_REPAIR_SUMMARY_VERSION =
  'promiseproof.codex-repair-summary.v1' as const;

export const REPAIR_ALLOWED_PATHS = [
  'src/client/main.ts',
  'tests/regression/initialization-order.spec.ts',
] as const;

export const REPAIR_INSPECTION_COMMANDS = Object.freeze([
  "Get-Content -Raw -Encoding UTF8 -LiteralPath 'src/client/main.ts'",
  "Get-Content -Raw -Encoding UTF8 -LiteralPath 'tests/support/scenario.ts'",
] as const);

export const REPAIR_CONSTRAINT_CODES = [
  'source_and_regression_only',
  'no_contract_changes',
  'human_review_required',
  'playwright_owns_verdict',
] as const;

export const repairAgentSummarySchema = z
  .object({
    schemaVersion: z.literal(CODEX_REPAIR_SUMMARY_VERSION),
    intent: z.literal('candidate_patch_prepared'),
    changedFiles: z
      .array(
        z
          .object({
            path: z.enum(REPAIR_ALLOWED_PATHS),
            purpose: z.enum(['source_repair', 'regression_test']),
          })
          .strict(),
      )
      .length(2),
    constraintCodes: z.tuple([
      z.literal(REPAIR_CONSTRAINT_CODES[0]),
      z.literal(REPAIR_CONSTRAINT_CODES[1]),
      z.literal(REPAIR_CONSTRAINT_CODES[2]),
      z.literal(REPAIR_CONSTRAINT_CODES[3]),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    const [source, regression] = value.changedFiles;
    if (
      source?.path !== REPAIR_ALLOWED_PATHS[0] ||
      source.purpose !== 'source_repair' ||
      regression?.path !== REPAIR_ALLOWED_PATHS[1] ||
      regression.purpose !== 'regression_test'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Codex must report the two allowed files in canonical order.',
      });
    }
  });

export type RepairAgentSummaryV1 = z.infer<typeof repairAgentSummarySchema>;

export const REPAIR_AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: {
      type: 'string',
      enum: [CODEX_REPAIR_SUMMARY_VERSION],
    },
    intent: { type: 'string', enum: ['candidate_patch_prepared'] },
    changedFiles: {
      type: 'array',
      minItems: 2,
      maxItems: 2,
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', enum: [...REPAIR_ALLOWED_PATHS] },
          purpose: {
            type: 'string',
            enum: ['source_repair', 'regression_test'],
          },
        },
        required: ['path', 'purpose'],
        additionalProperties: false,
      },
    },
    constraintCodes: {
      type: 'array',
      minItems: 4,
      maxItems: 4,
      items: { type: 'string', enum: [...REPAIR_CONSTRAINT_CODES] },
    },
  },
  required: ['schemaVersion', 'intent', 'changedFiles', 'constraintCodes'],
  additionalProperties: false,
} as const;

export interface RepairProviderInput {
  worktreePath: string;
  codexHomePath: string;
  toolTempPath: string;
  prompt: string;
  apiKey: string;
  timeoutMs: number;
  sensitiveValues: readonly string[];
}

export interface RepairProviderUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface RepairProviderEventSummary {
  eventCount: number;
  serializedBytesObserved: number;
  eventTypeCounts: Record<string, number>;
  completedItemTypeCounts: Record<string, number>;
  completedCommandCount: number;
  completedFileChangeCount: number;
  observedFilePaths: string[];
  sanitizedSequenceSha256: string;
}

export interface RepairProviderResult {
  kind: 'openai-codex-sdk' | 'offline-deterministic';
  requestedModel: typeof CODEX_REPAIR_MODEL | 'offline-codex-fixture';
  sdkVersion: string;
  cliVersion: string;
  threadId: string;
  turnsUsed: 1;
  summary: RepairAgentSummaryV1;
  finalResponseSha256: string;
  usage: RepairProviderUsage;
  events: RepairProviderEventSummary;
  timing: {
    startedAt: string;
    completedAt: string;
    totalMs: number;
  };
  validationCodes: string[];
}

export interface RepairProvider {
  prepareRepair(input: RepairProviderInput): Promise<RepairProviderResult>;
}

export const REPAIR_COMMAND_CLASSES = [
  'git_metadata_read',
  'path_probe',
  'repository_search',
  'test_or_build',
  'other',
] as const;

export const REPAIR_COMMAND_EXIT_DISPOSITIONS = [
  'zero',
  'positive_nonzero',
  'negative_nonzero',
  'missing',
] as const;

export const REPAIR_COMMAND_FAILURE_REASONS = [
  'approval_policy_declined',
  'status_not_completed',
  'exit_code_nonzero',
  'exit_code_missing',
] as const;

export interface SafeRepairCommandFailureDiagnostic {
  commandClass: (typeof REPAIR_COMMAND_CLASSES)[number];
  exitDisposition: (typeof REPAIR_COMMAND_EXIT_DISPOSITIONS)[number];
  exitCode: number | null;
  outputBytes: number;
  reason: (typeof REPAIR_COMMAND_FAILURE_REASONS)[number];
}

export interface SafeRepairProviderFailure {
  code: string;
  message: string;
  eventCount: number;
  serializedBytesObserved: number;
  commandFailure?: SafeRepairCommandFailureDiagnostic;
}

export class RepairProviderError extends Error {
  constructor(readonly details: SafeRepairProviderFailure) {
    super(`${details.code}: ${details.message}`);
    this.name = 'RepairProviderError';
  }
}
