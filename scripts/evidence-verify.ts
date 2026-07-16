import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';

export const EVIDENCE_DIRECTORY =
  'docs/evidence/milestone-04-authentic-repair' as const;
export const REPAIR_ID = 'c52183ec-2075-47e9-a1fb-7902e028dc42' as const;
export const PATCH_SHA256 =
  '62e2924d0d5c6d88d40e5fae47a95607661f900ae0889a4105df58b8e83557f7' as const;
export const PATCH_BYTES = 2311 as const;

type JsonObject = Record<string, unknown>;

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type GitRunner = (args: readonly string[]) => GitResult;

export interface EvidenceVerificationInput {
  readonly projectRoot?: string;
  readonly evidenceDirectory?: string;
  readonly git?: GitRunner;
}

export class EvidenceVerificationError extends Error {
  constructor(message: string) {
    super(`PP_EVIDENCE_INVALID: ${message}`);
  }
}

function fail(message: string): never {
  throw new EvidenceVerificationError(message);
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a nonempty string.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative safe integer.`);
  }
  return value;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array.`);
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function defaultGit(projectRoot: string): GitRunner {
  return (args) => {
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
  };
}

function gitOk(git: GitRunner, args: readonly string[], label: string): string {
  const result = git(args);
  if (result.code !== 0) {
    fail(`${label} failed.`);
  }
  return result.stdout.trim();
}

function safeRelativePath(value: string, label: string): void {
  if (
    value.length === 0 ||
    value.includes('..') ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[A-Za-z]:/.test(value)
  ) {
    fail(`${label} is not a safe repository-relative path.`);
  }
}

function readBytes(root: string, relative: string): Buffer {
  safeRelativePath(relative, 'artifact path');
  const target = resolve(root, relative);
  if (!target.startsWith(`${resolve(root)}${sep}`)) {
    fail('artifact path escaped the evidence directory.');
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    fail(`required artifact is missing: ${relative}.`);
  }
  return readFileSync(target);
}

function readJson(root: string, relative: string): JsonObject {
  const bytes = readBytes(root, relative);
  try {
    return object(JSON.parse(bytes.toString('utf8')), relative);
  } catch (error) {
    if (error instanceof EvidenceVerificationError) {
      throw error;
    }
    fail(`${relative} is not valid JSON.`);
  }
}

function allFiles(root: string, relative = ''): readonly string[] {
  const directory = resolve(root, relative);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      return allFiles(root, entryRelative);
    }
    return entry.isFile() ? [entryRelative] : [];
  });
}

function assertSanitized(root: string): void {
  const forbidden = [
    /\b[A-Za-z]:[\\/]/,
    /\\\\[^\\/]+[\\/]/,
    /(?:^|\/)Users\//,
    /(?:^|\/)home\//,
    /OPENAI_API_KEY/i,
    /\bsk-[A-Za-z0-9_-]{8,}/,
    /(?:api[_-]?key|authorization)\s*[:=]/i,
    /process\.env/i,
    /developer_instructions/i,
    /"prompt"\s*:/i,
    /"reasoning"\s*:/i,
    /chain[_-]?of[_-]?thought/i,
  ];
  for (const relative of allFiles(root)) {
    const text = readBytes(root, relative).toString('utf8');
    if (forbidden.some((pattern) => pattern.test(text))) {
      fail(`forbidden sensitive material was found in ${relative}.`);
    }
    if (relative.endsWith('.json')) {
      try {
        JSON.parse(text);
      } catch {
        fail(`${relative} is not valid JSON.`);
      }
    }
  }
}

function patchStats(patch: string): { additions: number; deletions: number } {
  const lines = patch.split('\n');
  return {
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
  };
}

function patchPaths(patch: string): readonly string[] {
  const paths = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((match) => {
    if (match[1] !== match[2] || match[1] === undefined) {
      fail('candidate.patch contains an unexpected rename or malformed path.');
    }
    return match[1];
  });
  if (paths.length !== 2) {
    fail('candidate.patch must contain exactly two file sections.');
  }
  return paths;
}

function patchBlobs(patch: string): { readonly before: string; readonly after: string } {
  const sourceSection = patch.split(/^diff --git /m)[1];
  const match = sourceSection?.match(/^index ([0-9a-f]{40})\.\.([0-9a-f]{40}) 100644$/m);
  if (match?.[1] === undefined || match[2] === undefined) {
    fail('candidate.patch source pre-image metadata is malformed.');
  }
  return { before: match[1], after: match[2] };
}

function exactStrings(value: unknown, label: string): readonly string[] {
  return array(value, label).map((entry, index) => string(entry, `${label}[${index}]`));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function verifyEvidence(input: EvidenceVerificationInput = {}): void {
  const projectRoot = resolve(input.projectRoot ?? process.cwd());
  const evidenceRoot = resolve(projectRoot, input.evidenceDirectory ?? EVIDENCE_DIRECTORY);
  const git = input.git ?? defaultGit(projectRoot);
  const summary = readJson(evidenceRoot, 'summary.json');
  const manifest = readJson(evidenceRoot, 'artifact-manifest.json');

  if (summary.schemaVersion !== 'promiseproof.milestone-04-authentic-repair-evidence.v1') {
    fail('summary schema version is unexpected.');
  }
  if (manifest.schemaVersion !== 'promiseproof.milestone-04-artifact-manifest.v1') {
    fail('artifact manifest schema version is unexpected.');
  }
  if (summary.evidencePackage === null || typeof summary.evidencePackage !== 'object') {
    fail('summary is missing the evidence-package classification.');
  }

  const repair = object(summary.repair, 'summary.repair');
  const repairId = string(repair.repairId, 'summary.repair.repairId');
  if (repairId !== REPAIR_ID || manifest.repairId !== repairId) {
    fail('repair ID is inconsistent.');
  }
  const baseCommit = string(repair.baseCommit, 'summary.repair.baseCommit');
  const baseTree = string(repair.baseTree, 'summary.repair.baseTree');
  const changedPaths = exactStrings(repair.changedPaths, 'summary.repair.changedPaths');
  const expectedPaths = ['src/client/main.ts', 'tests/regression/initialization-order.spec.ts'];
  if (!sameStrings(changedPaths, expectedPaths)) {
    fail('changed paths are inconsistent.');
  }
  if (repair.patchSha256 !== PATCH_SHA256 || number(repair.patchBytes, 'summary.repair.patchBytes') !== PATCH_BYTES) {
    fail('summary patch metadata is inconsistent.');
  }

  const approval = object(summary.humanApproval, 'summary.humanApproval');
  if (approval.state !== 'approved') {
    fail('human approval state is not approved.');
  }
  const verification = object(summary.verification, 'summary.verification');
  if (verification.verdict !== 'pass') {
    fail('verification verdict is not pass.');
  }
  if (verification.authority !== 'unchanged_playwright_and_deterministic_evaluator') {
    fail('verification authority is unexpected.');
  }
  if (object(summary.cleanup, 'summary.cleanup').state !== 'cleanup_completed') {
    fail('cleanup state is inconsistent.');
  }

  const artifacts = array(manifest.artifacts, 'artifact manifest artifacts');
  const requiredIds = new Set([
    'approved_patch',
    'human_approval_receipt',
    'lifecycle_and_cleanup_receipt',
    'verification_receipt',
    'candidate_state',
    'playwright_propagation_expected_red_metadata',
    'playwright_propagation_green_metadata',
    'playwright_race_off_five_metadata',
    'playwright_race_off_single_metadata',
    'playwright_race_on_five_metadata',
    'playwright_race_on_single_metadata',
    'playwright_startup_regression_metadata',
  ]);
  const byId = new Map<string, JsonObject>();
  for (const entry of artifacts) {
    const artifact = object(entry, 'artifact manifest entry');
    const id = string(artifact.id, 'artifact ID');
    if (!requiredIds.delete(id) || byId.has(id)) {
      fail(`artifact ID is unexpected or duplicated: ${id}.`);
    }
    byId.set(id, artifact);
    const classification = string(artifact.classification, `artifact ${id} classification`);
    const relative = string(artifact.path, `artifact ${id} path`);
    const bytes = readBytes(evidenceRoot, relative);
    if (classification === 'authentic_original_machine_artifact') {
      if (relative.startsWith('sanitized/') || artifact.sourceOriginal !== undefined) {
        fail(`derivative is falsely labelled as an original machine artifact: ${id}.`);
      }
      if (sha256(bytes) !== string(artifact.sha256, `artifact ${id} digest`) || bytes.length !== number(artifact.bytes, `artifact ${id} bytes`)) {
        fail(`original artifact digest or byte count is inconsistent: ${id}.`);
      }
    } else if (classification === 'sanitized_derivative') {
      if (!relative.startsWith('sanitized/')) {
        fail(`sanitized derivative is outside the sanitized directory: ${id}.`);
      }
      const source = object(artifact.sourceOriginal, `derivative ${id} source linkage`);
      string(source.sha256, `derivative ${id} original digest`);
      number(source.bytes, `derivative ${id} original bytes`);
    } else {
      fail(`artifact has an unsupported classification: ${id}.`);
    }
  }
  if (requiredIds.size !== 0) {
    fail(`required artifact is missing from manifest: ${[...requiredIds].sort().join(', ')}.`);
  }

  const patch = readBytes(evidenceRoot, 'candidate.patch');
  if (sha256(patch) !== PATCH_SHA256 || patch.length !== PATCH_BYTES) {
    fail('candidate.patch digest or byte count is inconsistent.');
  }
  const patchText = patch.toString('utf8');
  if (!sameStrings(patchPaths(patchText), changedPaths)) {
    fail('candidate.patch changed paths are inconsistent.');
  }
  const stats = patchStats(patchText);
  if (stats.additions !== number(repair.patchAdditions, 'summary.repair.patchAdditions') || stats.deletions !== number(repair.patchDeletions, 'summary.repair.patchDeletions')) {
    fail('candidate.patch additions or deletions are inconsistent.');
  }
  const blobs = patchBlobs(patchText);

  gitOk(git, ['rev-parse', '--verify', `${baseCommit}^{commit}`], 'documented base commit lookup');
  if (gitOk(git, ['rev-parse', '--verify', `${baseCommit}^{tree}`], 'documented base tree lookup') !== baseTree) {
    fail('documented base tree does not match the base commit.');
  }
  if (gitOk(git, ['rev-parse', '--verify', `${baseCommit}:src/client/main.ts`], 'base source blob lookup') !== blobs.before) {
    fail('candidate.patch pre-image does not match the documented base.');
  }
  if (git(['cat-file', '-e', `${baseCommit}:tests/regression/initialization-order.spec.ts`]).code === 0) {
    fail('documented base unexpectedly contains the regression test.');
  }
  gitOk(git, ['apply', '--check', '--', resolve(evidenceRoot, 'candidate.patch')], 'candidate.patch apply check');

  if (gitOk(git, ['rev-parse', '--verify', 'HEAD:src/client/main.ts'], 'main source blob lookup') === blobs.after) {
    fail('repaired source blob is silently present on main.');
  }
  if (git(['cat-file', '-e', 'HEAD:tests/regression/initialization-order.spec.ts']).code === 0) {
    fail('regression-test blob is silently present on main.');
  }
  const mainSource = gitOk(git, ['show', 'HEAD:src/client/main.ts'], 'main source lookup');
  const raceBranch = mainSource.indexOf('if (demoMode === "initialization-race")');
  const collector = mainSource.indexOf('await runStartupCollector();', raceBranch);
  const hydration = mainSource.indexOf('await hydratePreference();', raceBranch);
  if (raceBranch < 0 || collector < 0 || hydration < 0 || collector >= hydration) {
    fail('main no longer contains the seeded initialization-race ordering.');
  }

  const human = readJson(evidenceRoot, 'original/human-decision.json');
  if (human.schemaVersion !== 'promiseproof.human-repair-decision.v1' || human.repairId !== repairId || human.decision !== 'approved' || human.patchSha256 !== PATCH_SHA256 || human.patchBytes !== PATCH_BYTES) {
    fail('original human approval receipt is inconsistent.');
  }
  if (approval.approvalSha256 !== sha256(readBytes(evidenceRoot, 'original/human-decision.json'))) {
    fail('summary approval digest does not match the original human receipt.');
  }
  if (human.sha256 !== undefined) {
    fail('human approval receipt must remain byte-for-byte original, not carry a derivative digest field.');
  }
  const lifecycle = readJson(evidenceRoot, 'original/lifecycle.json');
  const events = array(lifecycle.events, 'lifecycle events');
  const finalEvent = object(events.at(-1), 'final lifecycle event');
  if (lifecycle.schemaVersion !== 'promiseproof.repair-lifecycle.v1' || lifecycle.repairId !== repairId || finalEvent.state !== 'cleanup_completed') {
    fail('original lifecycle or cleanup receipt is inconsistent.');
  }
  const receipt = readJson(evidenceRoot, 'original/verification-receipt.json');
  if (receipt.schemaVersion !== 'promiseproof.repair-verification.v1' || receipt.repairId !== repairId || receipt.verdict !== 'pass' || receipt.baseCommit !== baseCommit || receipt.approvedPatchSha256 !== PATCH_SHA256 || receipt.patchBytes !== PATCH_BYTES) {
    fail('original verification receipt is inconsistent.');
  }
  if (receipt.verificationWorktreeFresh !== true || receipt.candidateAndVerificationWorktreesDistinct !== true || receipt.patchAppliedByExactDigest !== true || receipt.patchUnchangedAfterVerification !== true) {
    fail('verification receipt does not retain the required worktree and patch facts.');
  }
  if (verification.verificationReceiptSha256 !== sha256(readBytes(evidenceRoot, 'original/verification-receipt.json'))) {
    fail('summary verification digest does not match the original receipt.');
  }
  const checks = object(receipt.checks, 'verification receipt checks');
  if (checks.build !== true || number(checks.propagationGreenTestCount, 'propagation green count') !== 6 || number(checks.startupRegressionTestCount, 'startup regression count') !== 1) {
    fail('verification test matrix is inconsistent.');
  }
  const propagation = object(checks.propagationExpectedRed, 'propagation expected-red check');
  if (propagation.verdict !== 'fail' || !sameStrings(exactStrings(propagation.violationCodes, 'propagation violation codes'), ['PP_PREFERENCE_NOT_PERSISTED'])) {
    fail('propagation expected-red control is inconsistent.');
  }

  const derivative = readJson(evidenceRoot, 'sanitized/candidate-state.json');
  const sourceOriginal = object(derivative.sourceOriginal, 'sanitized state source linkage');
  if (derivative.schemaVersion !== 'promiseproof.milestone-04-candidate-state-sanitized.v1' || derivative.artifactKind !== 'sanitized_derivative' || derivative.repairId !== repairId || derivative.state !== 'cleanup_completed' || sourceOriginal.sha256 !== '0df60e1a3559faba0d0fd647a17f6c13ad136f214c95c2462f7fb5de3e11311f') {
    fail('sanitized candidate-state derivative is inconsistent.');
  }
  const derivativeVerification = object(derivative.verification, 'sanitized state verification');
  if (derivativeVerification.authority !== verification.authority || derivativeVerification.verdict !== verification.verdict) {
    fail('sanitized candidate-state derivative conflicts with summary verification.');
  }
  const stateManifest = byId.get('candidate_state');
  if (stateManifest === undefined) {
    fail('candidate-state derivative manifest entry is missing.');
  }
  const stateManifestSource = object(stateManifest.sourceOriginal, 'candidate-state manifest source linkage');
  if (
    stateManifestSource.sha256 !== sourceOriginal.sha256 ||
    stateManifestSource.bytes !== sourceOriginal.bytes ||
    stateManifestSource.schemaVersion !== sourceOriginal.schemaVersion
  ) {
    fail('candidate-state derivative source linkage is inconsistent.');
  }

  assertSanitized(evidenceRoot);
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/evidence-verify.ts')) {
  try {
    verifyEvidence();
    process.stdout.write(`Evidence verification passed for ${REPAIR_ID}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
