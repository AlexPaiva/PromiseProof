import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  EVIDENCE_DIRECTORY,
  PATCH_BYTES,
  PATCH_SHA256,
  REPAIR_ID,
  verifyEvidence,
} from '../../scripts/evidence-verify.js';
import { canonicalJson } from '../investigation/canonical-json.js';
import { allocateLoopbackPort } from '../repair/runner.js';
import { validateRepairDiff } from '../repair/diff-validator.js';
import { runGit } from '../repair/git.js';
import {
  cleanupDisposableWorktree,
  createDisposableWorktree,
  type DisposableWorktree,
} from '../repair/worktree.js';
import {
  verifyApprovedRepair,
  type RepairVerificationReceiptV1,
} from '../repair/verification.js';

export const JUDGE_BUNDLE_PATH = 'artifacts/judge/judge-bundle.json' as const;
export const INVESTIGATION_ARTIFACT_PATH =
  'artifacts/milestone-03-live-stability.json' as const;
export const AUTHORITY =
  'unchanged_playwright_and_deterministic_evaluator' as const;
export const PROVENANCE_LABELS = [
  'recorded_authentic_gpt56',
  'recorded_authentic_codex',
  'reproducible_offline_verification',
  'deterministic_verdict',
] as const;

const BASE_COMMIT = 'bcadb6ea75b17666e8e509cbfb25b7f838cf846c' as const;
const EXPECTED_PATHS = [
  'src/client/main.ts',
  'tests/regression/initialization-order.spec.ts',
] as const;
const EXPECTED_RACE_CODE = 'PP_IDENTIFIABLE_EVENT_LEAK' as const;
const EXPECTED_PROPAGATION_CODE = 'PP_PREFERENCE_NOT_PERSISTED' as const;
const PP_CODE_PATTERN = /\bPP_[A-Z0-9_]+\b/gu;

type JsonRecord = Record<string, unknown>;
type ProvenanceLabel = (typeof PROVENANCE_LABELS)[number];

export interface JudgeBundle {
  readonly schemaVersion: 'promiseproof.judge-bundle.v1';
  readonly product: { readonly name: 'PromiseProof'; readonly descriptor: string };
  readonly canonicalPromise: string;
  readonly observedContradiction: {
    readonly scenario: 'off';
    readonly result: 'broken';
    readonly violationCode: typeof EXPECTED_RACE_CODE;
  };
  readonly initialHypotheses: readonly {
    readonly id: string;
    readonly statement: string;
    readonly result: 'supported' | 'not_selected';
  }[];
  readonly investigation: {
    readonly label: 'Recorded authentic GPT-5.6 run';
    readonly selectedReplay: 'inspect_startup_order';
    readonly replayExpectation: string;
    readonly observedTimeline: readonly string[];
    readonly postReplayResult: string;
    readonly provenance: 'recorded_authentic_gpt56';
  };
  readonly repair: {
    readonly label: 'Recorded authentic Codex repair';
    readonly repairId: typeof REPAIR_ID;
    readonly baseCommit: typeof BASE_COMMIT;
    readonly patchSha256: typeof PATCH_SHA256;
    readonly patchBytes: typeof PATCH_BYTES;
    readonly changedPaths: typeof EXPECTED_PATHS;
    readonly humanApproval: 'approved';
    readonly provenance: 'recorded_authentic_codex';
  };
  readonly verification: {
    readonly label: 'Reproducible offline verification';
    readonly matrix: {
      readonly off: 'pass';
      readonly reload: 'pass';
      readonly on: 'pass';
      readonly browser: 'pass';
      readonly propagationControl: 'pass';
    };
    readonly authority: typeof AUTHORITY;
    readonly provenance: readonly [
      'reproducible_offline_verification',
      'deterministic_verdict',
    ];
  };
}

export class JudgeRehearsalError extends Error {
  constructor(message: string) {
    super(`PP_JUDGE_REHEARSAL_INVALID: ${message}`);
    this.name = 'JudgeRehearsalError';
  }
}

function fail(message: string): never {
  throw new JudgeRehearsalError(message);
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a nonempty string.`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
  }
  return value;
}

function exactStrings(value: unknown, expected: readonly string[], label: string): void {
  const actual = array(value, label).map((entry, index) => string(entry, `${label}[${index}]`));
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    fail(`${label} is inconsistent.`);
  }
}

async function readJson(projectRoot: string, relative: string): Promise<JsonRecord> {
  try {
    return record(JSON.parse(await readFile(path.join(projectRoot, relative), 'utf8')) as unknown, relative);
  } catch (error) {
    if (error instanceof JudgeRehearsalError) {
      throw error;
    }
    fail(`${relative} is missing or malformed.`);
  }
}

function uniqueCodes(text: string): readonly string[] {
  return [...new Set(text.match(PP_CODE_PATTERN) ?? [])].sort();
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedBundle(): JudgeBundle {
  return {
    schemaVersion: 'promiseproof.judge-bundle.v1',
    product: {
      name: 'PromiseProof',
      descriptor: 'Deterministic verification of an activity-based personalization promise.',
    },
    canonicalPromise: 'When personalization is OFF, no identifiable activity reaches recommendations, contextual recommendations remain functional, and the preference survives reload. When ON, expected activity reaches recommendations and behavioral recommendations remain functional.',
    observedContradiction: {
      scenario: 'off',
      result: 'broken',
      violationCode: EXPECTED_RACE_CODE,
    },
    initialHypotheses: [
      {
        id: 'h1',
        statement: 'Activity collection begins before the saved preference is hydrated.',
        result: 'supported',
      },
      {
        id: 'h2',
        statement: 'The backend preference is not retained after an OFF update.',
        result: 'not_selected',
      },
    ],
    investigation: {
      label: 'Recorded authentic GPT-5.6 run',
      selectedReplay: 'inspect_startup_order',
      replayExpectation: 'The replay checks whether collection begins before preference hydration.',
      observedTimeline: [
        'collector_started',
        'identifiable_activity_received',
        'preference_hydration_completed',
      ],
      postReplayResult: 'Collection began before preference hydration.',
      provenance: 'recorded_authentic_gpt56',
    },
    repair: {
      label: 'Recorded authentic Codex repair',
      repairId: REPAIR_ID,
      baseCommit: BASE_COMMIT,
      patchSha256: PATCH_SHA256,
      patchBytes: PATCH_BYTES,
      changedPaths: EXPECTED_PATHS,
      humanApproval: 'approved',
      provenance: 'recorded_authentic_codex',
    },
    verification: {
      label: 'Reproducible offline verification',
      matrix: {
        off: 'pass',
        reload: 'pass',
        on: 'pass',
        browser: 'pass',
        propagationControl: 'pass',
      },
      authority: AUTHORITY,
      provenance: [
        'reproducible_offline_verification',
        'deterministic_verdict',
      ],
    },
  };
}

export function renderJudgeBundle(): string {
  return `${JSON.stringify(expectedBundle(), null, 2)}\n`;
}

export async function verifyJudgeBundle(projectRoot = process.cwd()): Promise<JudgeBundle> {
  const body = await readFile(path.join(projectRoot, JUDGE_BUNDLE_PATH), 'utf8').catch(() => {
    fail(`${JUDGE_BUNDLE_PATH} is missing.`);
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    fail(`${JUDGE_BUNDLE_PATH} is not valid JSON.`);
  }
  const actual = record(parsed, 'judge bundle');
  const expected = expectedBundle();
  if (canonicalJson(actual) !== canonicalJson(expected) || body !== renderJudgeBundle()) {
    fail('judge bundle does not exactly match the tracked evidence-derived bundle.');
  }
  return expected;
}

export async function validateRecordedInvestigation(projectRoot: string): Promise<void> {
  const receipt = await readJson(projectRoot, INVESTIGATION_ARTIFACT_PATH);
  if (
    receipt.schemaVersion !== 'promiseproof.live-stability-receipt.v1' ||
    receipt.requestedModel !== 'gpt-5.6' ||
    receipt.totalRuns !== 6 ||
    receipt.totalResponses !== 12 ||
    receipt.productVerdictAuthority !== 'deterministic_typescript_and_playwright_only'
  ) {
    fail('recorded investigation receipt has an unexpected identity or authority.');
  }
  const groups = array(receipt.groups, 'recorded investigation groups');
  const race = groups.map((value) => record(value, 'recorded investigation group')).find(
    (group) => group.evidenceSignature === 'identifiable_activity_leak',
  );
  if (race === undefined || race.expectedViolationCode !== EXPECTED_RACE_CODE || race.selectedReplay !== 'inspect_startup_order' || race.runCount !== 3 || race.responseCount !== 6) {
    fail('recorded race investigation cohort is inconsistent.');
  }
  const facts = record(race.verifiedFactualSignature, 'recorded race factual signature');
  if (facts.collectorBeforeHydration !== true || facts.activityBeforePreferenceRead !== true) {
    fail('recorded startup-order facts are inconsistent.');
  }
  const runs = array(race.runs, 'recorded race investigation runs');
  if (runs.length !== 3) {
    fail('recorded race investigation must contain exactly three runs.');
  }
  for (const [index, rawRun] of runs.entries()) {
    const run = record(rawRun, `recorded race run ${index}`);
    const responses = array(run.responses, `recorded race run ${index} responses`);
    if (responses.length !== 2) {
      fail('recorded race run must contain one replay selection and one hypothesis update.');
    }
    for (const response of responses) {
      const item = record(response, 'recorded model response');
      if (item.model !== 'gpt-5.6-sol' || item.status !== 'completed') {
        fail('recorded model identity is inconsistent.');
      }
      if ('verdict' in item || 'verificationVerdict' in item) {
        fail('recorded model material must not control a verification verdict.');
      }
    }
  }
}

export async function validateRecordedRepair(projectRoot: string): Promise<void> {
  const evidenceRoot = path.join(projectRoot, EVIDENCE_DIRECTORY);
  const [summary, approval, receipt, patch] = await Promise.all([
    readJson(projectRoot, `${EVIDENCE_DIRECTORY}/summary.json`),
    readJson(projectRoot, `${EVIDENCE_DIRECTORY}/original/human-decision.json`),
    readJson(projectRoot, `${EVIDENCE_DIRECTORY}/original/verification-receipt.json`),
    readFile(path.join(evidenceRoot, 'candidate.patch')),
  ]);
  const repair = record(summary.repair, 'recorded repair summary');
  if (
    repair.repairId !== REPAIR_ID || repair.baseCommit !== BASE_COMMIT ||
    repair.patchSha256 !== PATCH_SHA256 || repair.patchBytes !== PATCH_BYTES ||
    sha256(patch) !== PATCH_SHA256 || patch.byteLength !== PATCH_BYTES
  ) {
    fail('recorded repair metadata or patch digest is inconsistent.');
  }
  exactStrings(repair.changedPaths, EXPECTED_PATHS, 'recorded repair changed paths');
  if (
    approval.schemaVersion !== 'promiseproof.human-repair-decision.v1' ||
    approval.repairId !== REPAIR_ID || approval.decision !== 'approved' ||
    approval.patchSha256 !== PATCH_SHA256 || approval.patchBytes !== PATCH_BYTES
  ) {
    fail('recorded human decision is inconsistent.');
  }
  if (
    receipt.schemaVersion !== 'promiseproof.repair-verification.v1' ||
    receipt.repairId !== REPAIR_ID || receipt.baseCommit !== BASE_COMMIT ||
    receipt.approvedPatchSha256 !== PATCH_SHA256 || receipt.patchBytes !== PATCH_BYTES ||
    receipt.verdict !== 'pass'
  ) {
    fail('recorded repair verification receipt is inconsistent.');
  }
  const verification = record(summary.verification, 'recorded verification summary');
  if (verification.authority !== AUTHORITY || verification.verdict !== 'pass') {
    fail('recorded repair verification authority is inconsistent.');
  }
}

async function runChild(input: {
  readonly cwd: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<{ readonly exitCode: number | null; readonly output: string; readonly error: string | null }> {
  return await new Promise((resolvePromise) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.environment ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    let error: string | null = null;
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk));
    child.on('error', (failure) => { error = failure.message; });
    child.on('close', (exitCode) => {
      resolvePromise({ exitCode, output: Buffer.concat(output).toString('utf8'), error });
    });
  });
}

export function offlineEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source, NO_COLOR: '1' };
  delete environment.OPENAI_API_KEY;
  delete environment.OPENAI_BASE_URL;
  delete environment.CODEX_HOME;
  delete environment.FORCE_COLOR;
  return environment;
}

async function runExpectedRedControls(projectRoot: string): Promise<void> {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !path.isAbsolute(npmCli)) {
    fail('npm_execpath is unavailable; run the rehearsal through npm.');
  }
  const environment = offlineEnvironment();
  const result = await runChild({
    cwd: projectRoot,
    executable: process.execPath,
    args: [npmCli, 'run', 'test:expected-red'],
    environment,
  });
  const expectedRedPasses = result.output.match(/EXPECTED RED PASS/gu) ?? [];
  if (
    result.error !== null ||
    result.exitCode !== 0 ||
    expectedRedPasses.length !== 2 ||
    !result.output.includes(EXPECTED_RACE_CODE) ||
    !result.output.includes(EXPECTED_PROPAGATION_CODE) ||
    !result.output.includes('Expected-red verification passed for both seeded fixtures.')
  ) {
    fail('canonical expected-red validation did not prove both exact seeded violations.');
  }
}

export async function assertSeededBrokenMain(projectRoot: string): Promise<void> {
  const source = (await runGit(projectRoot, ['show', 'HEAD:src/client/main.ts'])).stdout;
  const branch = source.indexOf('if (demoMode === "initialization-race")');
  const collector = source.indexOf('await runStartupCollector();', branch);
  const hydration = source.indexOf('await hydratePreference();', branch);
  if (branch < 0 || collector < 0 || hydration < 0 || collector >= hydration) {
    fail('main no longer contains the seeded initialization race.');
  }
}

async function assertCleanMain(projectRoot: string): Promise<void> {
  const status = (await runGit(projectRoot, ['status', '--porcelain=v1', '-z'])).stdout;
  if (status.length !== 0) {
    fail('main checkout must be clean before and after rehearsal.');
  }
}

async function cloneAtBase(projectRoot: string, temporaryRoot: string): Promise<string> {
  const clonePath = path.join(temporaryRoot, 'recorded-base');
  await runGit(projectRoot, ['clone', '--no-local', '--no-checkout', projectRoot, clonePath]);
  await runGit(clonePath, ['checkout', '--detach', BASE_COMMIT]);
  const head = (await runGit(clonePath, ['rev-parse', '--verify', 'HEAD^{commit}'])).stdout.trim();
  if (head !== BASE_COMMIT) {
    fail('disposable rehearsal repository did not resolve to the documented base.');
  }
  return clonePath;
}

export function receiptPasses(receipt: RepairVerificationReceiptV1): boolean {
  const off = receipt.checks.raceOffSingle;
  const on = receipt.checks.raceOnSingle;
  const control = receipt.checks.propagationExpectedRed;
  return receipt.verdict === 'pass' &&
    off.identifiableActivityRequests === 0 && off.identifiableActivityReceipts === 0 &&
    off.recommendationSource === 'contextual' && off.reloadObserved === true && off.browserErrorCount === 0 &&
    on.identifiableActivityRequests === 1 && on.identifiableActivityReceipts === 1 &&
    on.recommendationSource === 'behavioral' && on.browserErrorCount === 0 &&
    control.violationCodes.length === 1 && control.violationCodes[0] === EXPECTED_PROPAGATION_CODE &&
    control.browserErrorCount === 0;
}

export interface RehearsalResult {
  readonly authority: typeof AUTHORITY;
  readonly semanticResult: 'pass';
}

export async function runJudgeRehearsal(projectRoot = process.cwd()): Promise<RehearsalResult> {
  await assertCleanMain(projectRoot);
  verifyEvidence({ projectRoot });
  await Promise.all([
    verifyJudgeBundle(projectRoot),
    validateRecordedInvestigation(projectRoot),
    validateRecordedRepair(projectRoot),
  ]);
  await assertSeededBrokenMain(projectRoot);
  await runExpectedRedControls(projectRoot);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'promiseproof-judge-rehearsal-'));
  let candidate: DisposableWorktree | undefined;
  let verification: DisposableWorktree | undefined;
  try {
    const repository = await cloneAtBase(projectRoot, temporaryRoot);
    candidate = await createDisposableWorktree(repository);
    const retainedPatchPath = path.join(projectRoot, EVIDENCE_DIRECTORY, 'candidate.patch');
    await runGit(candidate.worktreePath, ['apply', '--check', '--whitespace=error-all', '--', retainedPatchPath]);
    await runGit(candidate.worktreePath, ['apply', '--whitespace=error-all', '--', retainedPatchPath]);
    const candidateDiff = await validateRepairDiff(candidate);
    if (candidateDiff.patchSha256 !== PATCH_SHA256 || candidateDiff.patchBytes !== PATCH_BYTES || candidateDiff.baseHead !== BASE_COMMIT) {
      fail('applied rehearsal patch differs from the approved patch.');
    }
    verification = await createDisposableWorktree(repository);
    const approval = await readJson(projectRoot, `${EVIDENCE_DIRECTORY}/original/human-decision.json`);
    const port = await allocateLoopbackPort();
    const receipt = await verifyApprovedRepair({
      expectedRepairId: REPAIR_ID,
      verificationWorktree: verification,
      candidateWorktreePath: candidate.worktreePath,
      retainedPatchPath,
      expectedPatchBytes: PATCH_BYTES,
      expectedBaseCommit: BASE_COMMIT,
      approval: approval as never,
      verificationArtifactRoot: path.join(temporaryRoot, 'reproducible-offline-verification'),
      isolatedPort: port,
    });
    if (!receiptPasses(receipt)) {
      fail('unchanged verifier did not prove the required rehearsal matrix.');
    }
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const handle of [verification, candidate]) {
      if (handle !== undefined) {
        try {
          await cleanupDisposableWorktree(handle);
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    try {
      await rm(temporaryRoot, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, 'Disposable rehearsal cleanup failed.');
    }
  }
  await assertCleanMain(projectRoot);
  await assertSeededBrokenMain(projectRoot);
  return { authority: AUTHORITY, semanticResult: 'pass' };
}

export function formatJudgeOutput(): string {
  return [
    'PromiseProof — authentic repair rehearsal',
    '',
    'OBSERVE',
    'Promise: Personalization OFF blocks identifiable activity',
    'Observed: BROKEN',
    `Violation: ${EXPECTED_RACE_CODE}`,
    '',
    'INVESTIGATE',
    'Recorded authentic GPT-5.6 run',
    'Selected replay: Inspect startup order',
    'Observation: collection began before preference hydration',
    '',
    'REPAIR',
    'Recorded authentic Codex repair',
    'Files changed: 2',
    'Patch digest: verified',
    'Human approval: digest-bound',
    '',
    'PROVE',
    'OFF       0 identifiable activity    contextual feed     PASS',
    'RELOAD    remains OFF                no leak              PASS',
    'ON        expected activity          behavioral feed      PASS',
    'BROWSER   0 console/page errors                           PASS',
    'CONTROL   propagation still detected                     PASS',
    '',
    'Authority:',
    'Unchanged Playwright and deterministic evaluator',
    '',
  ].join('\n');
}
