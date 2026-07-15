import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';

const DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024;
const IN_PROGRESS_GIT_PATHS = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-apply',
  'rebase-merge',
  'BISECT_START',
  'sequencer',
] as const;

export interface GitCommandOptions {
  readonly acceptedExitCodes?: readonly number[];
  readonly maxBufferBytes?: number;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly exitCode: number | null;
    readonly stderr: string;
    readonly cause?: unknown;
  }) {
    const detail = input.stderr.trim();
    super(
      `Git command failed${
        input.exitCode === null ? '' : ` with exit code ${input.exitCode}`
      }: git ${input.args.join(' ')}${detail.length === 0 ? '' : `\n${detail}`}`,
      { cause: input.cause },
    );
    this.name = 'GitCommandError';
    this.args = Object.freeze([...input.args]);
    this.cwd = input.cwd;
    this.exitCode = input.exitCode;
    this.stderr = input.stderr;
  }
}

export type GitStatusKind =
  | 'tracked'
  | 'untracked'
  | 'ignored'
  | 'renamed_or_copied'
  | 'unmerged';

export interface GitStatusEntry {
  readonly kind: GitStatusKind;
  readonly indexStatus: string;
  readonly worktreeStatus: string;
  readonly path: string;
  readonly originalPath?: string;
}

export interface GitRefEntry {
  readonly name: string;
  readonly objectId: string;
  readonly symbolicTarget: string | null;
}

export interface GitRefState {
  readonly refs: readonly GitRefEntry[];
}

export interface CleanRepositorySnapshot {
  readonly repoRoot: string;
  readonly gitCommonDir: string;
  readonly baseHead: string;
  readonly headRef: string | null;
  readonly refState: GitRefState;
}

function exitCodeFromError(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const acceptedExitCodes = new Set(options.acceptedExitCodes ?? [0]);
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0) {
    throw new TypeError('maxBufferBytes must be a positive safe integer.');
  }

  const deterministicArgs = [
    '-c',
    'color.ui=false',
    '-c',
    'core.quotepath=false',
    '-c',
    'core.pager=cat',
    '-c',
    'core.hooksPath=',
    '-c',
    'core.fsmonitor=false',
    ...args,
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/iu.test(name)) {
      environment[name] = value;
    }
  }
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_PAGER = 'cat';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.LANG = 'C';
  environment.LC_ALL = 'C';

  return await new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      deterministicArgs,
      {
        cwd,
        encoding: 'utf8',
        env: environment,
        maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error === null ? 0 : exitCodeFromError(error);
        if (exitCode !== null && acceptedExitCodes.has(exitCode)) {
          resolvePromise(
            Object.freeze({
              stdout,
              stderr,
              exitCode,
            }),
          );
          return;
        }

        rejectPromise(
          new GitCommandError({
            args,
            cwd,
            exitCode,
            stderr,
            cause: error ?? undefined,
          }),
        );
      },
    );
  });
}

export function assertRelativeRepositoryPath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    isAbsolute(path) ||
    /^[a-zA-Z]:[\\/]/.test(path)
  ) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(path)}`);
  }

  const segments = path.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..',
    ) ||
    segments.some((segment) => segment.toLowerCase() === '.git') ||
    posix.normalize(path) !== path
  ) {
    throw new Error(`Unsafe repository-relative path: ${JSON.stringify(path)}`);
  }
}

export function isPathInside(parent: string, candidate: string): boolean {
  const fromParent = relative(resolve(parent), resolve(candidate));
  return (
    fromParent.length > 0 &&
    fromParent !== '..' &&
    !fromParent.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(fromParent)
  );
}

export function resolveRepositoryPath(repoRoot: string, path: string): string {
  assertRelativeRepositoryPath(path);
  const candidate = resolve(repoRoot, ...path.split('/'));
  if (!isPathInside(repoRoot, candidate)) {
    throw new Error(`Repository path escapes its root: ${JSON.stringify(path)}`);
  }
  return candidate;
}

function statusKind(indexStatus: string, worktreeStatus: string): GitStatusKind {
  if (indexStatus === '?' && worktreeStatus === '?') {
    return 'untracked';
  }
  if (indexStatus === '!' && worktreeStatus === '!') {
    return 'ignored';
  }
  if (
    indexStatus === 'R' ||
    indexStatus === 'C' ||
    worktreeStatus === 'R' ||
    worktreeStatus === 'C'
  ) {
    return 'renamed_or_copied';
  }
  if (
    ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(
      `${indexStatus}${worktreeStatus}`,
    )
  ) {
    return 'unmerged';
  }
  return 'tracked';
}

export function parsePorcelainV1Z(output: string): readonly GitStatusEntry[] {
  if (output.length === 0) {
    return Object.freeze([]);
  }
  if (!output.endsWith('\0')) {
    throw new Error('Malformed Git porcelain output: missing NUL terminator.');
  }

  const records = output.split('\0');
  records.pop();
  const entries: GitStatusEntry[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record === undefined ||
      record.length < 4 ||
      record[2] !== ' '
    ) {
      throw new Error('Malformed Git porcelain status record.');
    }

    const indexStatus = record[0]!;
    const worktreeStatus = record[1]!;
    const path = record.slice(3);
    assertRelativeRepositoryPath(path);
    const kind = statusKind(indexStatus, worktreeStatus);

    let originalPath: string | undefined;
    if (kind === 'renamed_or_copied') {
      originalPath = records[index + 1];
      if (originalPath === undefined) {
        throw new Error('Malformed rename/copy status record.');
      }
      assertRelativeRepositoryPath(originalPath);
      index += 1;
    }

    entries.push(
      Object.freeze({
        kind,
        indexStatus,
        worktreeStatus,
        path,
        ...(originalPath === undefined ? {} : { originalPath }),
      }),
    );
  }

  return Object.freeze(entries);
}

export async function listGitStatus(
  repoRoot: string,
  options: { readonly includeIgnored?: boolean } = {},
): Promise<readonly GitStatusEntry[]> {
  const args = [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ];
  if (options.includeIgnored === true) {
    args.push('--ignored=matching');
  }
  const result = await runGit(repoRoot, args);
  return parsePorcelainV1Z(result.stdout);
}

async function gitPathExists(repoRoot: string, name: string): Promise<boolean> {
  const result = await runGit(repoRoot, ['rev-parse', '--git-path', name]);
  const candidate = resolve(repoRoot, result.stdout.trim());
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { readonly code?: unknown }).code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

export async function assertNoGitOperationInProgress(
  repoRoot: string,
): Promise<void> {
  const active: string[] = [];
  for (const name of IN_PROGRESS_GIT_PATHS) {
    if (await gitPathExists(repoRoot, name)) {
      active.push(name);
    }
  }
  if (active.length > 0) {
    throw new Error(`Git operation is in progress: ${active.join(', ')}`);
  }
}

export async function assertCleanRepository(repoRoot: string): Promise<void> {
  const status = await listGitStatus(repoRoot);
  if (status.length > 0) {
    throw new Error(
      `Repository must be clean; found changes at: ${status
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }
  await assertNoGitOperationInProgress(repoRoot);
}

export async function captureHeadRef(repoRoot: string): Promise<string | null> {
  const result = await runGit(
    repoRoot,
    ['symbolic-ref', '--quiet', 'HEAD'],
    { acceptedExitCodes: [0, 1] },
  );
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function captureRefState(repoRoot: string): Promise<GitRefState> {
  const result = await runGit(repoRoot, [
    'for-each-ref',
    '--sort=refname',
    '--format=%(refname)%09%(objectname)%09%(symref)',
  ]);
  const refs = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line): GitRefEntry => {
      const [name, objectId, symbolicTarget = ''] = line.split('\t');
      if (
        name === undefined ||
        objectId === undefined ||
        !name.startsWith('refs/') ||
        !/^[a-f0-9]+$/u.test(objectId)
      ) {
        throw new Error('Malformed Git reference record.');
      }
      return Object.freeze({
        name,
        objectId,
        symbolicTarget: symbolicTarget.length === 0 ? null : symbolicTarget,
      });
    });
  return Object.freeze({ refs: Object.freeze(refs) });
}

export function equalRefStates(left: GitRefState, right: GitRefState): boolean {
  if (left.refs.length !== right.refs.length) {
    return false;
  }
  return left.refs.every((entry, index) => {
    const other = right.refs[index];
    return (
      other !== undefined &&
      entry.name === other.name &&
      entry.objectId === other.objectId &&
      entry.symbolicTarget === other.symbolicTarget
    );
  });
}

export async function resolveCleanRepository(
  startPath: string,
): Promise<CleanRepositorySnapshot> {
  const resolvedStart = await realpath(startPath);
  const inside = await runGit(resolvedStart, [
    'rev-parse',
    '--is-inside-work-tree',
  ]);
  if (inside.stdout.trim() !== 'true') {
    throw new Error('Path is not inside a Git worktree.');
  }

  const rootResult = await runGit(resolvedStart, [
    'rev-parse',
    '--show-toplevel',
  ]);
  const repoRoot = await realpath(rootResult.stdout.trim());
  await assertCleanRepository(repoRoot);

  const headResult = await runGit(repoRoot, [
    'rev-parse',
    '--verify',
    'HEAD^{commit}',
  ]);
  const baseHead = headResult.stdout.trim();
  if (!/^[a-f0-9]+$/u.test(baseHead)) {
    throw new Error('Git returned an invalid base commit ID.');
  }

  const commonDirResult = await runGit(repoRoot, [
    'rev-parse',
    '--git-common-dir',
  ]);
  const gitCommonDir = await realpath(
    resolve(repoRoot, commonDirResult.stdout.trim()),
  );
  const headRef = await captureHeadRef(repoRoot);
  const refState = await captureRefState(repoRoot);

  return Object.freeze({
    repoRoot,
    gitCommonDir,
    baseHead,
    headRef,
    refState,
  });
}
