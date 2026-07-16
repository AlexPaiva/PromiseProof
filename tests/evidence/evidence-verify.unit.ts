import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  EvidenceVerificationError,
  type GitResult,
  type GitRunner,
  verifyEvidence,
} from '../../scripts/evidence-verify.js';

const roots = new Set<string>();
const projectRoot = process.cwd();
const sourceEvidence = resolve(
  projectRoot,
  'docs/evidence/milestone-04-authentic-repair',
);

afterEach(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
    roots.delete(root);
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), `promiseproof-evidence-${randomUUID()}-`));
  roots.add(root);
  const evidence = join(root, 'evidence');
  cpSync(sourceEvidence, evidence, { recursive: true });
  return evidence;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function expectInvalid(action: () => void): void {
  assert.throws(
    action,
    (error: unknown) => error instanceof EvidenceVerificationError,
  );
}

function systemGit(args: readonly string[]): GitResult {
  try {
    return {
      code: 0,
      stdout: execFileSync('git', [...args], {
        cwd: projectRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      }),
      stderr: '',
    };
  } catch (error: unknown) {
    const failure = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: failure.status ?? 1,
      stdout: Buffer.isBuffer(failure.stdout)
        ? failure.stdout.toString('utf8')
        : (failure.stdout ?? ''),
      stderr: Buffer.isBuffer(failure.stderr)
        ? failure.stderr.toString('utf8')
        : (failure.stderr ?? ''),
    };
  }
}

test('accepts the tracked authentic evidence package', () => {
  verifyEvidence({ projectRoot, evidenceDirectory: sourceEvidence });
});

test('rejects a modified approved patch', () => {
  const evidence = fixture();
  writeFileSync(join(evidence, 'candidate.patch'), 'modified\n', 'utf8');
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects a wrong patch digest', () => {
  const evidence = fixture();
  const summaryPath = join(evidence, 'summary.json');
  const summary = readJson(summaryPath);
  const repair = summary.repair as Record<string, unknown>;
  repair.patchSha256 = '0'.repeat(64);
  writeJson(summaryPath, summary);
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects a wrong repair ID', () => {
  const evidence = fixture();
  const summaryPath = join(evidence, 'summary.json');
  const summary = readJson(summaryPath);
  (summary.repair as Record<string, unknown>).repairId = randomUUID();
  writeJson(summaryPath, summary);
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects a missing original receipt', () => {
  const evidence = fixture();
  rmSync(join(evidence, 'original', 'human-decision.json'));
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects an altered base commit', () => {
  const evidence = fixture();
  const summaryPath = join(evidence, 'summary.json');
  const summary = readJson(summaryPath);
  (summary.repair as Record<string, unknown>).baseCommit = '0'.repeat(40);
  writeJson(summaryPath, summary);
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects a derivative falsely labelled as original', () => {
  const evidence = fixture();
  const manifestPath = join(evidence, 'artifact-manifest.json');
  const manifest = readJson(manifestPath);
  const artifacts = manifest.artifacts as Array<Record<string, unknown>>;
  const derivative = artifacts.find((artifact) => artifact.id === 'candidate_state');
  assert.ok(derivative);
  derivative.classification = 'authentic_original_machine_artifact';
  writeJson(manifestPath, manifest);
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence }));
});

test('rejects a repaired source blob silently present on main', () => {
  const evidence = fixture();
  const patch = readFileSync(join(evidence, 'candidate.patch'), 'utf8');
  const repairedBlob = patch.match(/^index [0-9a-f]{40}\.\.([0-9a-f]{40}) 100644$/m)?.[1];
  assert.ok(repairedBlob);
  const git: GitRunner = (args) => {
    if (args.join(' ') === 'rev-parse --verify HEAD:src/client/main.ts') {
      return { code: 0, stdout: `${repairedBlob}\n`, stderr: '' };
    }
    return systemGit(args);
  };
  expectInvalid(() => verifyEvidence({ projectRoot, evidenceDirectory: evidence, git }));
});
