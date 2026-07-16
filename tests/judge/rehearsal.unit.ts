import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  JUDGE_BUNDLE_PATH,
  JudgeRehearsalError,
  assertSeededBrokenMain,
  offlineEnvironment,
  receiptPasses,
  renderJudgeBundle,
  validateRecordedInvestigation,
  validateRecordedRepair,
  verifyJudgeBundle,
} from '../../src/judge/rehearsal.js';

const projectRoot = path.resolve('.');
const evidence = 'docs/evidence/milestone-04-authentic-repair';

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'promiseproof-judge-unit-'));
  await Promise.all([
    cp(path.join(projectRoot, evidence), path.join(root, evidence), { recursive: true }),
    cp(path.join(projectRoot, 'artifacts/milestone-03-live-stability.json'), path.join(root, 'artifacts/milestone-03-live-stability.json')),
  ]);
  await mkdir(path.join(root, path.dirname(JUDGE_BUNDLE_PATH)), { recursive: true });
  await writeFile(path.join(root, JUDGE_BUNDLE_PATH), renderJudgeBundle());
  return root;
}

async function rejects(action: () => Promise<unknown>): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof JudgeRehearsalError);
}

test('offline rehearsal environment removes model credentials and Codex configuration', () => {
  const environment = offlineEnvironment({
    OPENAI_API_KEY: 'not-used',
    OPENAI_BASE_URL: 'https://not-used.example',
    CODEX_HOME: 'not-used',
  });
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.equal(environment.CODEX_HOME, undefined);
  assert.equal(environment.NO_COLOR, '1');
});

test('strict bundle rejects a recorded artifact relabelled as live', async () => {
  const root = await fixture();
  try {
    const bundlePath = path.join(root, JUDGE_BUNDLE_PATH);
    const bundle = JSON.parse(await readFile(bundlePath, 'utf8')) as Record<string, unknown>;
    (bundle.investigation as Record<string, unknown>).label = 'Live GPT-5.6 run';
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
    await rejects(() => verifyJudgeBundle(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recorded repair rejects altered patch, wrong repair ID, and wrong base', async () => {
  for (const mutation of ['patch', 'repairId', 'baseCommit'] as const) {
    const root = await fixture();
    try {
      if (mutation === 'patch') {
        await writeFile(path.join(root, evidence, 'candidate.patch'), 'altered patch\n');
      } else {
        const summaryPath = path.join(root, evidence, 'summary.json');
        const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as { repair: Record<string, unknown> };
        summary.repair[mutation] = mutation === 'repairId'
          ? '00000000-0000-4000-8000-000000000000'
          : '0000000000000000000000000000000000000000';
        await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      }
      await rejects(() => validateRecordedRepair(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('recorded repair rejects an altered digest-bound human decision', async () => {
  const root = await fixture();
  try {
    const decisionPath = path.join(root, evidence, 'original/human-decision.json');
    const decision = JSON.parse(await readFile(decisionPath, 'utf8')) as Record<string, unknown>;
    decision.decision = 'rejected';
    await writeFile(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
    await rejects(() => validateRecordedRepair(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recorded investigation fails closed when its artifact is missing', async () => {
  const root = await fixture();
  try {
    await rm(path.join(root, 'artifacts/milestone-03-live-stability.json'));
    await rejects(() => validateRecordedInvestigation(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification matrix rejects missing propagation control, browser errors, and model verdict claims', async () => {
  const receipt = JSON.parse(
    await readFile(path.join(projectRoot, evidence, 'original/verification-receipt.json'), 'utf8'),
  ) as Record<string, unknown>;
  const clean = structuredClone(receipt) as Record<string, unknown>;
  assert.equal(receiptPasses(clean as never), true);

  const missingControl = structuredClone(clean) as { checks: Record<string, unknown> };
  (missingControl.checks.propagationExpectedRed as Record<string, unknown>).violationCodes = [];
  assert.equal(receiptPasses(missingControl as never), false);

  const browserErrors = structuredClone(clean) as { checks: Record<string, unknown> };
  (browserErrors.checks.raceOffSingle as Record<string, unknown>).browserErrorCount = 1;
  assert.equal(receiptPasses(browserErrors as never), false);

  const modelClaim = structuredClone(browserErrors) as Record<string, unknown>;
  modelClaim.modelVerificationVerdict = 'pass';
  assert.equal(receiptPasses(modelClaim as never), false);
});

test('main seeded-race assertion fails closed if the repaired source is present', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'promiseproof-judge-main-'));
  try {
    await mkdir(path.join(root, 'src/client'), { recursive: true });
    await writeFile(path.join(root, 'src/client/main.ts'), 'await hydratePreference();\nawait runStartupCollector();\n');
    const init = await import('../../src/repair/git.js');
    await init.runGit(root, ['init']);
    await init.runGit(root, ['config', 'user.name', 'PromiseProof test']);
    await init.runGit(root, ['config', 'user.email', 'test@example.invalid']);
    await init.runGit(root, ['add', '--', 'src/client/main.ts']);
    await init.runGit(root, ['commit', '-m', 'fixture']);
    await rejects(() => assertSeededBrokenMain(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tracked candidate patch remains the authenticated byte sequence', async () => {
  const patch = await readFile(path.join(projectRoot, evidence, 'candidate.patch'));
  assert.equal(
    createHash('sha256').update(patch).digest('hex'),
    '62e2924d0d5c6d88d40e5fae47a95607661f900ae0889a4105df58b8e83557f7',
  );
});
