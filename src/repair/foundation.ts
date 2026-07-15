import { createHash } from 'node:crypto';

import { z } from 'zod';

import { deepFreeze } from '../investigation/immutable.js';
import { assertRelativeRepositoryPath, runGit } from './git.js';

export const MILESTONE_03_TAG =
  'milestone-03-gpt56-investigation' as const;
export const MILESTONE_03_COMMIT =
  '65a5dd6a0bb23465b776c2010c1d8e6048ac46b0' as const;
export const MILESTONE_03_RECEIPT_PATH =
  'artifacts/milestone-03-live-stability.json' as const;
export const FOUNDATION_POLICY_VERSION =
  'promiseproof.m04-foundation-delta-policy.v1' as const;

export const FROZEN_CRITICAL_PATHS = [
  MILESTONE_03_RECEIPT_PATH,
  'src/client/main.ts',
  'src/shared/evaluator.ts',
  'src/shared/types.ts',
  'src/shared/diagnostics.ts',
  'src/server/api.ts',
  'src/server/domain.ts',
  'src/server/preference-service.ts',
  'src/server/store.ts',
  'src/investigation/contracts.ts',
  'src/investigation/dossier.ts',
  'src/investigation/dispatcher.ts',
  'src/investigation/openai-provider.ts',
  'src/investigation/prompt.ts',
  'src/investigation/runner.ts',
  'src/investigation/schemas.ts',
  'src/investigation/validation.ts',
  'tests/contracts/personalization-off.spec.ts',
  'tests/contracts/playwright.config.ts',
  'tests/control/personalization-on.spec.ts',
  'tests/support/scenario.ts',
  'tests/support/diagnostic-replays.ts',
  'tests/support/investigation-replays.ts',
  'scripts/verify-live-stability.ts',
] as const;

const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const criticalPathSchema = z.enum(FROZEN_CRITICAL_PATHS);

export const frozenFoundationSchema = z
  .object({
    policyVersion: z.literal(FOUNDATION_POLICY_VERSION),
    checkpointTag: z.literal(MILESTONE_03_TAG),
    checkpointCommit: z.literal(MILESTONE_03_COMMIT),
    baseCommit: z.string().regex(GIT_OBJECT_ID),
    baseTree: z.string().regex(GIT_OBJECT_ID),
    changedPathsFromCheckpoint: z.array(z.string().min(1)).min(1).max(256),
    allOtherCheckpointPathsUnchanged: z.literal(true),
    criticalFiles: z
      .array(
        z
          .object({
            path: criticalPathSchema,
            checkpointBlobId: z.string().regex(GIT_OBJECT_ID),
            baseBlobId: z.string().regex(GIT_OBJECT_ID),
            sha256: z.string().regex(SHA256),
          })
          .strict(),
      )
      .length(FROZEN_CRITICAL_PATHS.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.changedPathsFromCheckpoint.some(
        (entry, index) =>
          entry !== [...value.changedPathsFromCheckpoint].sort()[index],
      ) ||
      new Set(value.changedPathsFromCheckpoint).size !==
        value.changedPathsFromCheckpoint.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['changedPathsFromCheckpoint'],
        message: 'Foundation delta paths must be sorted and unique.',
      });
    }
    value.criticalFiles.forEach((entry, index) => {
      if (
        entry.path !== FROZEN_CRITICAL_PATHS[index] ||
        entry.checkpointBlobId !== entry.baseBlobId
      ) {
        context.addIssue({
          code: 'custom',
          path: ['criticalFiles', index],
          message: 'Critical file order or frozen blob identity changed.',
        });
      }
    });
  });

export type FrozenFoundationV1 = z.infer<typeof frozenFoundationSchema>;

function isAllowedMilestone04Delta(path: string): boolean {
  return (
    [
      'AGENTS.md',
      'BUILD_WEEK.md',
      'package.json',
      'package-lock.json',
      'scripts/repair-race.ts',
      'scripts/verify-repair-receipt.ts',
      'tests/support/deterministic-repair-provider.ts',
    ].includes(path) ||
    path.startsWith('src/repair/') ||
    path.startsWith('tests/repair/')
  );
}

function parseNameStatusZ(value: string): readonly {
  status: 'A' | 'M';
  path: string;
}[] {
  if (value.length === 0 || !value.endsWith('\0')) {
    throw new Error(
      'PP_REPAIR_FOUNDATION_DELTA_INVALID: expected a nonempty NUL-terminated Milestone 04 delta.',
    );
  }
  const fields = value.split('\0');
  fields.pop();
  if (fields.length % 2 !== 0) {
    throw new Error(
      'PP_REPAIR_FOUNDATION_DELTA_INVALID: malformed Git name-status output.',
    );
  }
  const entries: Array<{ status: 'A' | 'M'; path: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index];
    const path = fields[index + 1];
    if ((status !== 'A' && status !== 'M') || path === undefined) {
      throw new Error(
        'PP_REPAIR_FOUNDATION_DELTA_INVALID: only added or modified infrastructure files are allowed.',
      );
    }
    assertRelativeRepositoryPath(path);
    if (!isAllowedMilestone04Delta(path)) {
      throw new Error(
        `PP_REPAIR_FOUNDATION_CHANGED: Milestone 03 foundation path changed outside the repair-infrastructure allowlist: ${path}.`,
      );
    }
    entries.push({ status, path });
  }
  return entries;
}

async function blobId(
  projectRoot: string,
  commit: string,
  path: string,
): Promise<string> {
  const value = (
    await runGit(projectRoot, [
      'rev-parse',
      '--verify',
      `${commit}:${path}`,
    ])
  ).stdout.trim();
  if (!GIT_OBJECT_ID.test(value)) {
    throw new Error('PP_REPAIR_FOUNDATION_BLOB_INVALID: Git returned an invalid blob ID.');
  }
  return value;
}

export async function validateFrozenFoundation(input: {
  projectRoot: string;
  baseCommit: string;
  baseTree: string;
}): Promise<FrozenFoundationV1> {
  const tagCommit = (
    await runGit(input.projectRoot, [
      'rev-parse',
      '--verify',
      `${MILESTONE_03_TAG}^{commit}`,
    ])
  ).stdout.trim();
  if (tagCommit !== MILESTONE_03_COMMIT) {
    throw new Error(
      'PP_REPAIR_MILESTONE_TAG_CHANGED: frozen Milestone 03 tag no longer names its verified commit.',
    );
  }
  const ancestry = await runGit(
    input.projectRoot,
    ['merge-base', '--is-ancestor', MILESTONE_03_COMMIT, input.baseCommit],
    { acceptedExitCodes: [0, 1] },
  );
  if (ancestry.exitCode !== 0) {
    throw new Error(
      'PP_REPAIR_BASE_NOT_DESCENDANT: repair base does not descend from Milestone 03.',
    );
  }
  const delta = parseNameStatusZ(
    (
      await runGit(input.projectRoot, [
        'diff',
        '--name-status',
        '-z',
        '--no-renames',
        MILESTONE_03_COMMIT,
        input.baseCommit,
        '--',
      ])
    ).stdout,
  );
  const criticalFiles = await Promise.all(
    FROZEN_CRITICAL_PATHS.map(async (path) => {
      const [checkpointBlobId, baseBlobId, checkpointBody] = await Promise.all([
        blobId(input.projectRoot, MILESTONE_03_COMMIT, path),
        blobId(input.projectRoot, input.baseCommit, path),
        runGit(input.projectRoot, [
          'show',
          `${MILESTONE_03_COMMIT}:${path}`,
        ]),
      ]);
      return {
        path,
        checkpointBlobId,
        baseBlobId,
        sha256: createHash('sha256')
          .update(checkpointBody.stdout, 'utf8')
          .digest('hex'),
      };
    }),
  );
  return deepFreeze(
    frozenFoundationSchema.parse({
      policyVersion: FOUNDATION_POLICY_VERSION,
      checkpointTag: MILESTONE_03_TAG,
      checkpointCommit: MILESTONE_03_COMMIT,
      baseCommit: input.baseCommit,
      baseTree: input.baseTree,
      changedPathsFromCheckpoint: delta.map((entry) => entry.path).sort(),
      allOtherCheckpointPathsUnchanged: true,
      criticalFiles,
    }),
  );
}

export async function readFrozenMilestone03Receipt(
  projectRoot: string,
): Promise<unknown> {
  const body = (
    await runGit(projectRoot, [
      'show',
      `${MILESTONE_03_COMMIT}:${MILESTONE_03_RECEIPT_PATH}`,
    ])
  ).stdout;
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(
      'PP_REPAIR_RECEIPT_INVALID: frozen Milestone 03 receipt is not valid JSON.',
      { cause: error },
    );
  }
}
