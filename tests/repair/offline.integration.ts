import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  REPAIR_APPROVAL_VERSION,
  expectedReviewPhrase,
  humanRepairDecisionSchema,
} from '../../src/repair/approval.js';
import {
  appendRepairLifecycle,
  fileSha256,
  readLocalRepairState,
  writeLocalRepairState,
  writeNewJson,
} from '../../src/repair/artifact.js';
import { verifyHumanApprovedRaceRepair } from '../../src/repair/repair-flow.js';
import { prepareRaceRepair } from '../../src/repair/runner.js';
import { runGit } from '../../src/repair/git.js';
import {
  cleanupDisposableWorktree,
  reopenDisposableWorktree,
} from '../../src/repair/worktree.js';
import { DeterministicRepairProvider } from '../support/deterministic-repair-provider.js';

const sourceProjectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const LAST_ELIGIBLE_REHEARSAL_COMMIT =
  'd817f363813f407be0951f737573c9ec00725650';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

test(
  'offline two-worktree journey repairs race, preserves controls, and never changes main',
  { timeout: 12 * 60 * 1_000 },
  async () => {
    const sourceStatus = (
      await runGit(sourceProjectRoot, ['status', '--porcelain=v1'])
    ).stdout;
    assert.equal(
      sourceStatus,
      '',
      'Offline integration must run from the committed clean runner checkpoint.',
    );

    const root = await mkdtemp(
      path.join(tmpdir(), 'promiseproof-repair-offline-'),
    );
    const repository = path.join(root, 'repository');
    let statePath: string | null = null;
    try {
      await runGit(root, [
        'clone',
        '--no-hardlinks',
        '--quiet',
        sourceProjectRoot,
        repository,
      ]);
      const originalHead = (
        await runGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
      ).stdout.trim();
      await assert.rejects(
        prepareRaceRepair({
          projectRoot: repository,
          provider: new DeterministicRepairProvider(),
          apiKey: 'offline-test-only-not-a-real-platform-key',
        }),
        (error: unknown) =>
          error instanceof Error &&
          error.message.startsWith('PP_REPAIR_FOUNDATION_CHANGED:'),
      );
      await runGit(repository, [
        'checkout',
        '--detach',
        LAST_ELIGIBLE_REHEARSAL_COMMIT,
      ]);
      const rehearsalHead = (
        await runGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
      ).stdout.trim();
      assert.equal(rehearsalHead, LAST_ELIGIBLE_REHEARSAL_COMMIT);
      assert.notEqual(originalHead, rehearsalHead);
      const originalRefs = await runGit(repository, [
        'for-each-ref',
        '--sort=refname',
        '--format=%(refname)%09%(objectname)%09%(symref)',
      ]);
      const originalSource = await readFile(
        path.join(repository, 'src', 'client', 'main.ts'),
        'utf8',
      );

      const prepared = await prepareRaceRepair({
        projectRoot: repository,
        provider: new DeterministicRepairProvider(),
        apiKey: 'offline-test-only-not-a-real-platform-key',
      });
      statePath = prepared.statePath;
      assert.equal(prepared.state, 'awaiting_human_review');
      assert.equal(await fileSha256(prepared.patchPath), prepared.patchSha256);

      // Production exposes no approval adapter. This deliberately forged record
      // exists only in the offline test process so the post-gate mechanics can be
      // exercised without weakening the interactive TTY boundary.
      const state = structuredClone(await readLocalRepairState(statePath));
      assert.equal(state.state, 'awaiting_human_review');
      assert.notEqual(state.patch, null);
      assert.equal(await exists(state.codexHomePath), false);
      assert.equal(await exists(state.toolTempPath), false);
      const decision = humanRepairDecisionSchema.parse({
        schemaVersion: REPAIR_APPROVAL_VERSION,
        repairId: state.repairId,
        decision: 'approved',
        patchSha256: state.patch!.sha256,
        patchBytes: state.patch!.bytes,
        decidedAt: new Date().toISOString(),
        reviewer: 'human_operator',
        method: 'interactive_tty_exact_phrase',
        confirmationSha256: sha256(
          expectedReviewPhrase(
            'APPROVE',
            state.repairId,
            state.patch!.sha256,
          ),
        ),
      });
      await writeNewJson(state.approvalPath, decision);
      await appendRepairLifecycle(
        state.lifecyclePath,
        state.repairId,
        'human_approved',
        decision,
      );
      state.state = 'human_approved';
      state.approvalSha256 = await fileSha256(state.approvalPath);
      state.updatedAt = new Date().toISOString();
      await writeLocalRepairState(statePath, state);

      // Codex Desktop legitimately rotates this exact app-owned ref between
      // human review and a later command. It is excluded only from the
      // cross-turn source-integrity comparison; every live worktree firewall
      // still requires exact ref equality for the duration of its operation.
      const rotatedCaptureRef =
        'refs/codex/turn-diffs/captures/1784150000000/d0321504-ca0c-4dba-8735-d08a0ea8791d/base';
      assert.equal(
        state.baseRefState.refs.some((entry) => entry.name === rotatedCaptureRef),
        false,
      );
      await runGit(repository, [
        'update-ref',
        rotatedCaptureRef,
        state.baseCommit,
      ]);
      const verified = await verifyHumanApprovedRaceRepair({
        projectRoot: repository,
        repairId: state.repairId,
      }).finally(async () => {
        await runGit(repository, ['update-ref', '-d', rotatedCaptureRef]);
      });
      assert.equal(verified.receipt.verdict, 'pass');
      assert.equal(verified.cleanupState, 'cleanup_completed');
      assert.equal(verified.receipt.checks.raceOffFive.length, 5);
      assert.equal(verified.receipt.checks.raceOnFive.length, 5);
      assert.equal(
        verified.receipt.checks.propagationExpectedRed.violationCodes[0],
        'PP_PREFERENCE_NOT_PERSISTED',
      );
      assert.equal(verified.receipt.checks.propagationGreenTestCount, 6);
      assert.equal(verified.receipt.checks.startupRegressionTestCount, 1);

      const finalState = await readLocalRepairState(statePath);
      assert.equal(finalState.state, 'cleanup_completed');
      assert.equal(await exists(finalState.candidateWorktreePath), false);
      assert.notEqual(finalState.verificationWorktreePath, null);
      assert.equal(await exists(finalState.verificationWorktreePath!), false);
      assert.equal(
        await readFile(path.join(repository, 'src', 'client', 'main.ts'), 'utf8'),
        originalSource,
      );
      assert.equal(
        (
          await runGit(repository, ['rev-parse', '--verify', 'HEAD^{commit}'])
        ).stdout.trim(),
        rehearsalHead,
      );
      assert.equal(
        (
          await runGit(repository, [
            'for-each-ref',
            '--sort=refname',
            '--format=%(refname)%09%(objectname)%09%(symref)',
          ])
        ).stdout,
        originalRefs.stdout,
      );
      assert.equal(
        (await runGit(repository, ['status', '--porcelain=v1'])).stdout,
        '',
      );
    } finally {
      if (statePath !== null && (await exists(statePath))) {
        const state = await readLocalRepairState(statePath).catch(() => null);
        if (state !== null) {
          for (const candidate of [
            state.verificationWorktreePath,
            state.candidateWorktreePath,
          ]) {
            if (candidate !== null && (await exists(candidate))) {
              try {
                const handle = await reopenDisposableWorktree(
                  repository,
                  candidate,
                );
                await cleanupDisposableWorktree(handle);
              } catch {
                // The primary assertion retains the original failure. The entire
                // temporary root is still removed below when safe to do so.
              }
            }
          }
        }
      }
      await rm(root, { force: true, recursive: true, maxRetries: 3 });
    }
  },
);
