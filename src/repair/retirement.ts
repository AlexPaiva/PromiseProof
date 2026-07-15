import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { deepFreeze } from '../investigation/immutable.js';
import { INTEGRITY_REF_POLICY } from './git.js';

export const REPAIR_RETIREMENT_VERSION =
  'promiseproof.human-repair-retirement.v1' as const;
export const REPAIR_RETIREMENT_REASON = 'PP_REPAIR_BASE_CHANGED' as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/u;

export function expectedRetirementPhrase(
  repairId: string,
  patchSha256: string,
): string {
  return `RETIRE_UNVERIFIED ${repairId} ${patchSha256}`;
}

export function parseRetirementPhrase(
  value: string,
  repairId: string,
  patchSha256: string,
): void {
  if (value !== expectedRetirementPhrase(repairId, patchSha256)) {
    throw new Error(
      'PP_REPAIR_RETIREMENT_PHRASE_INVALID: the exact action, repair ID, and patch digest are required.',
    );
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export const humanRepairRetirementSchema = z
  .object({
    schemaVersion: z.literal(REPAIR_RETIREMENT_VERSION),
    repairId: z.string().uuid(),
    disposition: z.literal('retired_without_verification'),
    verificationVerdict: z.literal('not_run'),
    verificationStarted: z.literal(false),
    playwrightInvoked: z.literal(false),
    verificationWorktreeRetainedAtDecision: z.literal(false),
    verificationReceiptCreated: z.literal(false),
    patchSha256: z.string().regex(SHA256),
    patchBytes: z.number().int().positive().max(32 * 1024),
    approvalSha256: z.string().regex(SHA256),
    retainedBaseCommit: z.string().regex(GIT_OBJECT_ID),
    retainedBaseTree: z.string().regex(GIT_OBJECT_ID),
    retainedHeadRef: z.string().startsWith('refs/').nullable(),
    observedCurrentCommit: z.string().regex(GIT_OBJECT_ID),
    observedCurrentTree: z.string().regex(GIT_OBJECT_ID),
    observedCurrentHeadRef: z.string().startsWith('refs/').nullable(),
    retainedFullRefStateSha256: z.string().regex(SHA256),
    retainedIntegrityRefStateSha256: z.string().regex(SHA256),
    observedIntegrityRefStateSha256: z.string().regex(SHA256),
    integrityRefPolicy: z.literal(INTEGRITY_REF_POLICY),
    drift: z
      .object({
        headChanged: z.boolean(),
        headRefChanged: z.boolean(),
        integrityRefsChanged: z.boolean(),
        securityRelevantRefsAdded: z.number().int().nonnegative(),
        securityRelevantRefsRemoved: z.number().int().nonnegative(),
        securityRelevantRefsChanged: z.number().int().nonnegative(),
      })
      .strict(),
    candidateAudit: z
      .object({
        detached: z.literal(true),
        headMatchesRetainedBase: z.literal(true),
        diffMatchesApprovedPatch: z.literal(true),
        stagedChangeCount: z.literal(0),
        changedPaths: z.tuple([
          z.literal('src/client/main.ts'),
          z.literal('tests/regression/initialization-order.spec.ts'),
        ]),
      })
      .strict(),
    reasonCode: z.literal(REPAIR_RETIREMENT_REASON),
    nextAction: z.literal('prepare_fresh_candidate'),
    decidedAt: z.string().datetime(),
    reviewer: z.literal('human_operator'),
    method: z.literal('interactive_tty_exact_phrase'),
    confirmationSha256: z.string().regex(SHA256),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.confirmationSha256 !==
      digest(expectedRetirementPhrase(value.repairId, value.patchSha256))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['confirmationSha256'],
        message: 'Confirmation digest does not bind the exact retirement phrase.',
      });
    }
    if (
      !value.drift.headChanged &&
      !value.drift.headRefChanged &&
      !value.drift.integrityRefsChanged
    ) {
      context.addIssue({
        code: 'custom',
        path: ['drift'],
        message: 'Unverified retirement requires a real integrity-base change.',
      });
    }
    if (
      value.drift.headChanged !==
        (value.retainedBaseCommit !== value.observedCurrentCommit) ||
      value.drift.headRefChanged !==
        (value.retainedHeadRef !== value.observedCurrentHeadRef) ||
      value.drift.integrityRefsChanged !==
        (value.retainedIntegrityRefStateSha256 !==
          value.observedIntegrityRefStateSha256)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['drift'],
        message: 'Drift flags do not match the bound commits, HEAD refs, and integrity-ref hashes.',
      });
    }
  });

export type HumanRepairRetirementV1 = z.infer<
  typeof humanRepairRetirementSchema
>;

export async function readHumanRepairRetirement(
  retirementPath: string,
): Promise<HumanRepairRetirementV1> {
  return deepFreeze(
    humanRepairRetirementSchema.parse(
      JSON.parse(await readFile(retirementPath, 'utf8')) as unknown,
    ),
  );
}
