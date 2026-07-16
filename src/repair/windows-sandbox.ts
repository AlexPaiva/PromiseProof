import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_REPAIR_CLI_VERSION } from './provider.js';

const SANDBOX_DIRECTORY = '.sandbox';
const SANDBOX_BIN_DIRECTORY = '.sandbox-bin';
const SANDBOX_SECRETS_DIRECTORY = '.sandbox-secrets';
const SETUP_MARKER_FILE = 'setup_marker.json';
const SANDBOX_USERS_FILE = 'sandbox_users.json';
const SETUP_MARKER_VERSION = 5;
const OFFLINE_USERNAME = 'CodexSandboxOffline';
const ONLINE_USERNAME = 'CodexSandboxOnline';
const PREFLIGHT_TIMEOUT_MS = 30_000;
const PREFLIGHT_MAX_BUFFER_BYTES = 64 * 1024;

export const ELEVATED_SANDBOX_HOME_ENV =
  'PROMISEPROOF_ELEVATED_SANDBOX_HOME' as const;

export type WindowsSandboxBoundaryCode =
  | 'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED'
  | 'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID'
  | 'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED'
  | 'PP_REPAIR_CODEX_SANDBOX_NETWORK_OPEN'
  | 'PP_REPAIR_CODEX_SANDBOX_SECRETS_READABLE'
  | 'PP_REPAIR_CODEX_SANDBOX_MARKER_READABLE'
  | 'PP_REPAIR_CODEX_SANDBOX_RUNNER_WRITABLE'
  | 'PP_REPAIR_CODEX_SANDBOX_WORKSPACE_UNREADABLE'
  | 'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED'
  | 'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE';

export class WindowsSandboxBoundaryError extends Error {
  readonly code: WindowsSandboxBoundaryCode;
  readonly publicMessage: string;
  readonly safeDiagnostic: string | undefined;

  constructor(
    code: WindowsSandboxBoundaryCode,
    message: string,
    cause?: unknown,
    safeDiagnostic?: string,
  ) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause });
    this.name = 'WindowsSandboxBoundaryError';
    this.code = code;
    this.publicMessage = message;
    this.safeDiagnostic = safeDiagnostic;
  }
}

export interface ElevatedWindowsSandboxRuntime {
  readonly codexHomePath: string;
  readonly toolTempPath: string;
  readonly cliEntrypointPath: string;
  readonly sandboxSecretsJunctionPath: string;
  readonly sandboxMarkerPath: string;
  readonly sandboxRunnerPath: string;
  readonly sandboxRunnerSha256: string;
  readonly setupMarkerSha256: string;
}

export interface ElevatedWindowsSandboxPreflight {
  readonly implementation: 'elevated';
  readonly workspaceReadAllowed: true;
  readonly sandboxSecretsReadBlocked: true;
  readonly setupMarkerReadBlocked: true;
  readonly commandRunnerWriteBlocked: true;
  readonly rawNetworkEgressBlocked: true;
}

interface ProvisionInput {
  readonly codexHomePath: string;
  readonly toolTempPath: string;
  readonly worktreePath: string;
  readonly hostCodexHomePath?: string;
  readonly trustedPowerShellExecutable: string;
  readonly sourceEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

interface CleanupInput {
  readonly tempRoot: string;
  readonly codexHomePath: string;
  readonly toolTempPath: string;
}

interface PreflightInput {
  readonly runtime: ElevatedWindowsSandboxRuntime;
  readonly worktreePath: string;
  readonly trustedPowerShellExecutable: string;
  readonly cliEnvironment: Readonly<Record<string, string>>;
}

interface SetupMarker {
  readonly version: number;
  readonly offline_username: string;
  readonly online_username: string;
  readonly created_at: string;
  readonly proxy_ports: unknown[];
  readonly allow_local_binding: boolean;
  readonly read_roots: unknown[];
  readonly write_roots: unknown[];
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function lstatOrNull(
  candidate: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}

async function assertRealDirectory(
  candidate: string,
  code: WindowsSandboxBoundaryCode,
  message: string,
): Promise<string> {
  let info;
  let resolved;
  try {
    [info, resolved] = await Promise.all([lstat(candidate), realpath(candidate)]);
  } catch (error) {
    throw new WindowsSandboxBoundaryError(code, message, error);
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(resolved, candidate)
  ) {
    throw new WindowsSandboxBoundaryError(code, message);
  }
  return resolved;
}

async function assertSingleRealFile(
  candidate: string,
  code: WindowsSandboxBoundaryCode,
  message: string,
): Promise<void> {
  let info;
  let resolved;
  try {
    [info, resolved] = await Promise.all([lstat(candidate), realpath(candidate)]);
  } catch (error) {
    throw new WindowsSandboxBoundaryError(code, message, error);
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !samePath(resolved, candidate)
  ) {
    throw new WindowsSandboxBoundaryError(code, message);
  }
}

function parseSetupMarker(value: string): SetupMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The elevated Windows sandbox setup marker is not valid JSON.',
      error,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The elevated Windows sandbox setup marker has an invalid shape.',
    );
  }
  const marker = parsed as Record<string, unknown>;
  const expectedKeys = [
    'allow_local_binding',
    'created_at',
    'offline_username',
    'online_username',
    'proxy_ports',
    'read_roots',
    'version',
    'write_roots',
  ];
  if (
    JSON.stringify(Object.keys(marker).sort()) !== JSON.stringify(expectedKeys) ||
    marker.version !== SETUP_MARKER_VERSION ||
    marker.offline_username !== OFFLINE_USERNAME ||
    marker.online_username !== ONLINE_USERNAME ||
    typeof marker.created_at !== 'string' ||
    !Number.isFinite(Date.parse(marker.created_at)) ||
    !Array.isArray(marker.proxy_ports) ||
    marker.proxy_ports.length !== 0 ||
    marker.allow_local_binding !== false ||
    !Array.isArray(marker.read_roots) ||
    marker.read_roots.length !== 0 ||
    !Array.isArray(marker.write_roots) ||
    marker.write_roots.length !== 0
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The elevated Windows sandbox setup marker differs from the pinned offline boundary.',
    );
  }
  return marker as unknown as SetupMarker;
}

function resolveHostCodexHome(
  explicit: string | undefined,
  sourceEnvironment: Readonly<NodeJS.ProcessEnv>,
): string {
  const configured = explicit ?? sourceEnvironment[ELEVATED_SANDBOX_HOME_ENV];
  if (configured !== undefined && configured.trim().length > 0) {
    if (!path.isAbsolute(configured)) {
      throw new WindowsSandboxBoundaryError(
        'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
        'The elevated Windows sandbox home override must be an absolute path.',
      );
    }
    return path.resolve(configured);
  }
  const userProfile = sourceEnvironment.USERPROFILE;
  if (userProfile === undefined || !path.isAbsolute(userProfile)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'A provisioned host Codex home could not be located for the elevated Windows sandbox.',
    );
  }
  return path.join(path.resolve(userProfile), '.codex');
}

async function pinnedCodexPaths(): Promise<{
  readonly cliEntrypointPath: string;
  readonly bundledRunnerPath: string;
}> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The bounded repair requires the pinned native Windows Codex runtime.',
    );
  }
  const platformPackage = `@openai/codex-win32-${process.arch}`;
  const targetTriple =
    process.arch === 'x64'
      ? 'x86_64-pc-windows-msvc'
      : 'aarch64-pc-windows-msvc';
  let platformPackageJson: string;
  let cliPackageJson: string;
  try {
    platformPackageJson = fileURLToPath(
      import.meta.resolve(`${platformPackage}/package.json`),
    );
    cliPackageJson = fileURLToPath(
      import.meta.resolve('@openai/codex/package.json'),
    );
  } catch (error) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The pinned native Windows Codex package is not installed.',
      error,
    );
  }
  let platformMetadata: unknown;
  let cliMetadata: unknown;
  let nativeMetadata: unknown;
  const nativeMetadataPath = path.join(
    path.dirname(platformPackageJson),
    'vendor',
    targetTriple,
    'codex-package.json',
  );
  try {
    [platformMetadata, cliMetadata, nativeMetadata] = await Promise.all([
      readFile(platformPackageJson, 'utf8').then(
        (value) => JSON.parse(value) as unknown,
      ),
      readFile(cliPackageJson, 'utf8').then(
        (value) => JSON.parse(value) as unknown,
      ),
      readFile(nativeMetadataPath, 'utf8').then(
        (value) => JSON.parse(value) as unknown,
      ),
    ]);
  } catch (error) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The pinned native Windows Codex package metadata is unreadable.',
      error,
    );
  }
  if (
    platformMetadata === null ||
    typeof platformMetadata !== 'object' ||
    (platformMetadata as { name?: unknown }).name !== '@openai/codex' ||
    (platformMetadata as { version?: unknown }).version !==
      `${CODEX_REPAIR_CLI_VERSION}-win32-${process.arch}` ||
    cliMetadata === null ||
    typeof cliMetadata !== 'object' ||
    (cliMetadata as { version?: unknown }).version !== CODEX_REPAIR_CLI_VERSION ||
    nativeMetadata === null ||
    typeof nativeMetadata !== 'object' ||
    (nativeMetadata as { layoutVersion?: unknown }).layoutVersion !== 1 ||
    (nativeMetadata as { version?: unknown }).version !==
      CODEX_REPAIR_CLI_VERSION ||
    (nativeMetadata as { target?: unknown }).target !== targetTriple ||
    (nativeMetadata as { variant?: unknown }).variant !== 'codex' ||
    (nativeMetadata as { entrypoint?: unknown }).entrypoint !== 'bin/codex.exe' ||
    (nativeMetadata as { resourcesDir?: unknown }).resourcesDir !==
      'codex-resources' ||
    (nativeMetadata as { pathDir?: unknown }).pathDir !== 'codex-path'
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The native Windows Codex package differs from the pinned CLI version.',
    );
  }
  const bundledRunnerPath = path.join(
    path.dirname(platformPackageJson),
    'vendor',
    targetTriple,
    'codex-resources',
    'codex-command-runner.exe',
  );
  const cliEntrypointPath = path.join(
    path.dirname(cliPackageJson),
    'bin',
    'codex.js',
  );
  await Promise.all([
    assertSingleRealFile(
      bundledRunnerPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The pinned Codex command runner is not one real package file.',
    ),
    assertSingleRealFile(
      cliEntrypointPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The pinned Codex CLI entrypoint is not one real package file.',
    ),
  ]);
  return { cliEntrypointPath, bundledRunnerPath };
}

export async function provisionElevatedWindowsSandbox(
  input: ProvisionInput,
): Promise<ElevatedWindowsSandboxRuntime> {
  if (process.platform !== 'win32') {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The bounded repair requires the native elevated Windows sandbox.',
    );
  }
  const codexHomePath = path.resolve(input.codexHomePath);
  const toolTempPath = path.resolve(input.toolTempPath);
  const worktreePath = path.resolve(input.worktreePath);
  const tempRoot = path.dirname(codexHomePath);
  if (
    path.basename(codexHomePath) !== 'codex-home' ||
    path.basename(toolTempPath) !== 'tool-temp' ||
    !samePath(path.dirname(toolTempPath), tempRoot) ||
    path.basename(worktreePath) !== 'checkout' ||
    !samePath(path.dirname(worktreePath), tempRoot)
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The isolated Codex runtime paths are outside the canonical disposable root.',
    );
  }
  await assertRealDirectory(
    tempRoot,
    'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
    'The isolated Codex runtime parent is not one real disposable directory.',
  );
  await assertRealDirectory(
    worktreePath,
    'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
    'The candidate worktree is not one real disposable directory.',
  );
  if (
    (await lstatOrNull(codexHomePath)) !== null ||
    (await lstatOrNull(toolTempPath)) !== null
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The isolated Codex runtime paths must be absent before provisioning.',
    );
  }

  const sourceEnvironment = input.sourceEnvironment ?? process.env;
  const hostCodexHomePath = resolveHostCodexHome(
    input.hostCodexHomePath,
    sourceEnvironment,
  );
  if (
    samePath(hostCodexHomePath, tempRoot) ||
    isPathInside(tempRoot, hostCodexHomePath) ||
    isPathInside(hostCodexHomePath, tempRoot) ||
    isPathInside(worktreePath, hostCodexHomePath)
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The host sandbox provisioning home overlaps the disposable repair root.',
    );
  }
  await assertRealDirectory(
    hostCodexHomePath,
    'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
    'The host Codex home has not been provisioned for the elevated Windows sandbox.',
  );
  const sourceSandboxPath = path.join(hostCodexHomePath, SANDBOX_DIRECTORY);
  const sourceSandboxBinPath = path.join(
    hostCodexHomePath,
    SANDBOX_BIN_DIRECTORY,
  );
  const sourceSecretsPath = path.join(
    hostCodexHomePath,
    SANDBOX_SECRETS_DIRECTORY,
  );
  await Promise.all([
    assertRealDirectory(
      sourceSandboxPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The elevated Windows sandbox setup directory is missing.',
    ),
    assertRealDirectory(
      sourceSandboxBinPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The elevated Windows sandbox command-runner directory is missing.',
    ),
    assertRealDirectory(
      sourceSecretsPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_REQUIRED',
      'The protected elevated Windows sandbox credential directory is missing.',
    ),
  ]);
  const sourceMarkerPath = path.join(sourceSandboxPath, SETUP_MARKER_FILE);
  const sourceRunnerPath = path.join(
    sourceSandboxBinPath,
    `codex-command-runner-${CODEX_REPAIR_CLI_VERSION}.exe`,
  );
  const sourceUsersPath = path.join(sourceSecretsPath, SANDBOX_USERS_FILE);
  await Promise.all([
    assertSingleRealFile(
      sourceMarkerPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The elevated Windows sandbox setup marker is not one real file.',
    ),
    assertSingleRealFile(
      sourceRunnerPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The provisioned sandbox command runner is linked, replaced, or missing.',
    ),
    assertSingleRealFile(
      sourceUsersPath,
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The protected sandbox credential file is linked, replaced, or missing.',
    ),
  ]);
  const markerBytes = await readFile(sourceMarkerPath);
  parseSetupMarker(markerBytes.toString('utf8'));
  const { cliEntrypointPath, bundledRunnerPath } = await pinnedCodexPaths();
  const [runnerBytes, provisionedRunnerBytes] = await Promise.all([
    readFile(bundledRunnerPath),
    readFile(sourceRunnerPath),
  ]);
  if (
    runnerBytes.byteLength === 0 ||
    sha256(runnerBytes) !== sha256(provisionedRunnerBytes)
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID',
      'The provisioned command runner differs from the pinned Codex package.',
    );
  }

  const sandboxPath = path.join(codexHomePath, SANDBOX_DIRECTORY);
  const sandboxBinPath = path.join(codexHomePath, SANDBOX_BIN_DIRECTORY);
  const sandboxSecretsJunctionPath = path.join(
    codexHomePath,
    SANDBOX_SECRETS_DIRECTORY,
  );
  const copiedMarkerPath = path.join(sandboxPath, SETUP_MARKER_FILE);
  const copiedRunnerPath = path.join(
    sandboxBinPath,
    `codex-command-runner-${CODEX_REPAIR_CLI_VERSION}.exe`,
  );
  let provisioningPhase = 'create_runtime_directories';
  try {
    await mkdir(codexHomePath, { recursive: false, mode: 0o700 });
    await mkdir(toolTempPath, { recursive: false, mode: 0o700 });
    await mkdir(sandboxPath, { recursive: false, mode: 0o700 });
    await mkdir(sandboxBinPath, { recursive: false, mode: 0o700 });
    provisioningPhase = 'copy_setup_marker';
    await copyFile(
      sourceMarkerPath,
      copiedMarkerPath,
      fsConstants.COPYFILE_EXCL,
    );
    provisioningPhase = 'copy_command_runner';
    await copyFile(
      bundledRunnerPath,
      copiedRunnerPath,
      fsConstants.COPYFILE_EXCL,
    );
    provisioningPhase = 'create_secrets_junction';
    await symlink(
      sourceSecretsPath,
      sandboxSecretsJunctionPath,
      'junction',
    );
    provisioningPhase = 'copy_control_acls';
    await copyRuntimeControlAcls({
      sourceMarkerPath,
      copiedMarkerPath,
      sourceRunnerPath,
      copiedRunnerPath,
      trustedPowerShellExecutable: input.trustedPowerShellExecutable,
      sourceEnvironment,
    });
  } catch (error) {
    const safeDiagnostic =
      error instanceof WindowsSandboxBoundaryError &&
      error.safeDiagnostic !== undefined
        ? error.safeDiagnostic
        : `phase=${provisioningPhase} outcome=operation_failed`;
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
      `The isolated elevated Windows sandbox runtime could not be provisioned. [${safeDiagnostic}]`,
      error,
      safeDiagnostic,
    );
  }

  const [junctionInfo, junctionTarget, copiedMarker, copiedRunner] =
    await Promise.all([
      lstat(sandboxSecretsJunctionPath),
      realpath(sandboxSecretsJunctionPath),
      readFile(copiedMarkerPath),
      readFile(copiedRunnerPath),
    ]);
  if (
    !junctionInfo.isSymbolicLink() ||
    !samePath(junctionTarget, sourceSecretsPath) ||
    sha256(copiedMarker) !== sha256(markerBytes) ||
    sha256(copiedRunner) !== sha256(runnerBytes)
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
      'The isolated elevated Windows sandbox runtime failed post-copy validation.',
    );
  }
  return Object.freeze({
    codexHomePath,
    toolTempPath,
    cliEntrypointPath,
    sandboxSecretsJunctionPath,
    sandboxMarkerPath: copiedMarkerPath,
    sandboxRunnerPath: copiedRunnerPath,
    sandboxRunnerSha256: sha256(copiedRunner),
    setupMarkerSha256: sha256(copiedMarker),
  });
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function copyRuntimeControlAcls(input: {
  readonly sourceMarkerPath: string;
  readonly copiedMarkerPath: string;
  readonly sourceRunnerPath: string;
  readonly copiedRunnerPath: string;
  readonly trustedPowerShellExecutable: string;
  readonly sourceEnvironment: Readonly<NodeJS.ProcessEnv>;
}): Promise<void> {
  const systemRoot =
    input.sourceEnvironment.SystemRoot ??
    input.sourceEnvironment.SYSTEMROOT ??
    input.sourceEnvironment.WINDIR;
  if (systemRoot === undefined || !path.win32.isAbsolute(systemRoot)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
      'The trusted Windows system root is unavailable for control-file ACL binding.',
    );
  }
  const normalizedSystemRoot = path.win32.normalize(systemRoot);
  const expectedPowerShell = path.win32.join(
    normalizedSystemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (!samePath(input.trustedPowerShellExecutable, expectedPowerShell)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
      'Control-file ACL binding did not receive the trusted native PowerShell executable.',
    );
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$sourceMarkerAcl = [System.IO.File]::GetAccessControl(${powerShellLiteral(input.sourceMarkerPath)})`,
    `$sourceRunnerAcl = [System.IO.File]::GetAccessControl(${powerShellLiteral(input.sourceRunnerPath)})`,
    '$sourceMarkerAcl.SetAccessRuleProtection($true, $true)',
    '$sourceRunnerAcl.SetAccessRuleProtection($true, $true)',
    `[System.IO.File]::SetAccessControl(${powerShellLiteral(input.copiedMarkerPath)}, $sourceMarkerAcl)`,
    `[System.IO.File]::SetAccessControl(${powerShellLiteral(input.copiedRunnerPath)}, $sourceRunnerAcl)`,
    `$copiedMarkerAcl = [System.IO.File]::GetAccessControl(${powerShellLiteral(input.copiedMarkerPath)})`,
    `$copiedRunnerAcl = [System.IO.File]::GetAccessControl(${powerShellLiteral(input.copiedRunnerPath)})`,
    'function Get-AclFingerprint($acl) { return (@($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.IdentityReference.Value, $_.AccessControlType, [int]$_.FileSystemRights, $_.InheritanceFlags, $_.PropagationFlags } | Sort-Object) -join "`n") }',
    'if ((-not $copiedMarkerAcl.AreAccessRulesProtected) -or ($sourceMarkerAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $copiedMarkerAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) -or ((Get-AclFingerprint $sourceMarkerAcl) -ne (Get-AclFingerprint $copiedMarkerAcl))) { exit 51 }',
    'if ((-not $copiedRunnerAcl.AreAccessRulesProtected) -or ($sourceRunnerAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $copiedRunnerAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) -or ((Get-AclFingerprint $sourceRunnerAcl) -ne (Get-AclFingerprint $copiedRunnerAcl))) { exit 52 }',
    'exit 0',
  ].join('; ');
  const system32 = path.win32.join(normalizedSystemRoot, 'System32');
  const outcome = await new Promise<ExecOutcome>((resolve) => {
    execFile(
      input.trustedPowerShellExecutable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: {
          PATH: [system32, path.win32.dirname(expectedPowerShell)].join(';'),
          SystemRoot: normalizedSystemRoot,
          WINDIR: normalizedSystemRoot,
          COMSPEC: path.win32.join(system32, 'cmd.exe'),
          PATHEXT: '.COM;.EXE;.BAT;.CMD',
        },
        encoding: 'utf8',
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
        timeout: PREFLIGHT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error) => {
        resolve(
          error === null
            ? { code: 0, killed: false, signal: null }
            : {
                code: typeof error.code === 'number' ? error.code : null,
                killed: error.killed ?? false,
                signal: error.signal ?? null,
              },
        );
      },
    );
  });
  if (outcome.code !== 0 || outcome.killed || outcome.signal !== null) {
    const safeDiagnostic = outcome.killed
      ? 'phase=copy_control_acls outcome=timeout'
      : outcome.signal !== null
        ? 'phase=copy_control_acls outcome=signal'
        : `phase=copy_control_acls outcome=powershell_exit_${outcome.code ?? 'unknown'}`;
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED',
      `The disposable control files did not inherit the validated host ACLs. [${safeDiagnostic}]`,
      undefined,
      safeDiagnostic,
    );
  }
}

function preflightScript(input: PreflightInput): string {
  const workspaceFile = path.join(
    input.worktreePath,
    'src',
    'client',
    'main.ts',
  );
  const secretFile = path.join(
    input.runtime.sandboxSecretsJunctionPath,
    SANDBOX_USERS_FILE,
  );
  return [
    "$ErrorActionPreference = 'Stop'",
    `$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name; if (-not $identity.EndsWith(${powerShellLiteral(`\\${OFFLINE_USERNAME}`)}, [StringComparison]::OrdinalIgnoreCase)) { exit 46 }`,
    `try { $content = [IO.File]::ReadAllText(${powerShellLiteral(workspaceFile)}); if ($content.Length -lt 1) { exit 43 } } catch { exit 43 }`,
    '$markerBlocked = $false',
    `try { $null = [IO.File]::ReadAllBytes(${powerShellLiteral(input.runtime.sandboxMarkerPath)}) } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if (($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException])) { $markerBlocked = $true } else { exit 45 } }`,
    'if (-not $markerBlocked) { exit 47 }',
    '$runnerWriteBlocked = $false',
    `try { $stream = [IO.File]::Open(${powerShellLiteral(input.runtime.sandboxRunnerPath)}, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::Read); $stream.Dispose() } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if (($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException])) { $runnerWriteBlocked = $true } else { exit 45 } }`,
    'if (-not $runnerWriteBlocked) { exit 48 }',
    '$secretBlocked = $false',
    `try { $null = [IO.File]::ReadAllBytes(${powerShellLiteral(secretFile)}) } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if (($exception -is [UnauthorizedAccessException]) -or ($exception -is [System.Security.SecurityException])) { $secretBlocked = $true } else { exit 45 } }`,
    'if (-not $secretBlocked) { exit 41 }',
    '$networkBlocked = $false',
    '$client = [System.Net.Sockets.TcpClient]::new()',
    "try { $task = $client.ConnectAsync([System.Net.IPAddress]::Parse('1.1.1.1'), 443); $completed = $task.Wait(3000); if (-not $completed) { exit 49 }; if ($client.Connected) { exit 42 }; exit 49 } catch { $exception = $_.Exception; while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }; if (($exception -is [System.Net.Sockets.SocketException]) -and ($exception.SocketErrorCode -eq [System.Net.Sockets.SocketError]::AccessDenied)) { $networkBlocked = $true } else { exit 49 } } finally { $client.Dispose() }",
    'if (-not $networkBlocked) { exit 49 }',
    'exit 0',
  ].join('; ');
}

interface ExecOutcome {
  readonly code: number | null;
  readonly killed: boolean;
  readonly signal: NodeJS.Signals | null;
}

async function executePreflight(input: PreflightInput): Promise<ExecOutcome> {
  const environment = { ...input.cliEnvironment };
  if (
    Object.keys(environment).some((key) =>
      /(?:API[_-]?KEY|AUTH|CREDENTIAL|SECRET|TOKEN)/iu.test(key),
    )
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
      'The sandbox preflight environment contains a credential-named variable.',
    );
  }
  return await new Promise<ExecOutcome>((resolve) => {
    execFile(
      process.execPath,
      [
        input.runtime.cliEntrypointPath,
        'sandbox',
        '-P',
        ':workspace',
        '-C',
        input.worktreePath,
        '--sandbox-state-disable-network',
        '-c',
        'windows.sandbox="elevated"',
        '--',
        input.trustedPowerShellExecutable,
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        preflightScript(input),
      ],
      {
        cwd: input.worktreePath,
        env: environment,
        encoding: 'utf8',
        maxBuffer: PREFLIGHT_MAX_BUFFER_BYTES,
        timeout: PREFLIGHT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error) => {
        if (error === null) {
          resolve({ code: 0, killed: false, signal: null });
          return;
        }
        resolve({
          code: typeof error.code === 'number' ? error.code : null,
          killed: error.killed ?? false,
          signal: error.signal ?? null,
        });
      },
    );
  });
}

export async function verifyElevatedWindowsSandbox(
  input: PreflightInput,
): Promise<ElevatedWindowsSandboxPreflight> {
  if (
    !samePath(input.runtime.codexHomePath, input.cliEnvironment.CODEX_HOME ?? '') ||
    !samePath(input.runtime.toolTempPath, input.cliEnvironment.TEMP ?? '') ||
    !samePath(input.runtime.toolTempPath, input.cliEnvironment.TMP ?? '')
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
      'The sandbox preflight environment is not bound to the isolated runtime.',
    );
  }
  const outcome = await executePreflight(input);
  if (outcome.code === 41) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_SECRETS_READABLE',
      'The elevated sandbox command could read its protected provisioning credential file.',
    );
  }
  if (outcome.code === 42) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_NETWORK_OPEN',
      'The elevated sandbox command established an external raw TCP connection.',
    );
  }
  if (outcome.code === 43) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_WORKSPACE_UNREADABLE',
      'The elevated sandbox command could not read the candidate source file.',
    );
  }
  if (outcome.code === 46) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
      'The elevated sandbox command did not run as the pinned offline sandbox identity.',
    );
  }
  if (outcome.code === 47) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_MARKER_READABLE',
      'The elevated sandbox command could read its protected setup marker.',
    );
  }
  if (outcome.code === 48) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_RUNNER_WRITABLE',
      'The elevated sandbox command could open its pinned command runner for writing.',
    );
  }
  if (outcome.code === 49) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
      'The raw TCP probe did not fail with the exact Windows access-denied signal.',
    );
  }
  if (outcome.code !== 0 || outcome.killed || outcome.signal !== null) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_CODEX_SANDBOX_PREFLIGHT_FAILED',
      'The elevated sandbox boundary preflight did not complete with its exact success code.',
    );
  }
  return Object.freeze({
    implementation: 'elevated',
    workspaceReadAllowed: true,
    sandboxSecretsReadBlocked: true,
    setupMarkerReadBlocked: true,
    commandRunnerWriteBlocked: true,
    rawNetworkEgressBlocked: true,
  });
}

async function assertNoReparsePoints(candidate: string): Promise<void> {
  for (const entry of await readdir(candidate)) {
    const child = path.join(candidate, entry);
    const info = await lstat(child);
    if (info.isSymbolicLink()) {
      throw new WindowsSandboxBoundaryError(
        'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
        'An unexpected reparse point remains inside the isolated provider runtime.',
      );
    }
    if (info.isDirectory()) {
      await assertNoReparsePoints(child);
    }
  }
}

async function removeRealRuntimeDirectory(
  candidate: string,
  expectedName: 'codex-home' | 'tool-temp',
  tempRoot: string,
): Promise<void> {
  const info = await lstatOrNull(candidate);
  if (info === null) {
    return;
  }
  if (
    path.basename(candidate) !== expectedName ||
    !samePath(path.dirname(candidate), tempRoot) ||
    !info.isDirectory() ||
    info.isSymbolicLink()
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The isolated provider runtime path was replaced or escaped its disposable root.',
    );
  }
  const resolved = await realpath(candidate);
  if (!samePath(resolved, candidate)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The isolated provider runtime resolves outside its canonical location.',
    );
  }
  if (expectedName === 'codex-home') {
    const secretsJunction = path.join(candidate, SANDBOX_SECRETS_DIRECTORY);
    const junctionInfo = await lstatOrNull(secretsJunction);
    if (junctionInfo !== null) {
      if (!junctionInfo.isSymbolicLink()) {
        throw new WindowsSandboxBoundaryError(
          'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
          'The protected sandbox credential junction was replaced by a real filesystem object.',
        );
      }
      await unlink(secretsJunction);
    }
  }
  await assertNoReparsePoints(resolved);
  await rm(resolved, {
    force: true,
    maxRetries: 3,
    recursive: true,
    retryDelay: 50,
  });
}

export async function cleanupIsolatedProviderRuntime(
  input: CleanupInput,
): Promise<void> {
  const tempRoot = path.resolve(input.tempRoot);
  const codexHomePath = path.resolve(input.codexHomePath);
  const toolTempPath = path.resolve(input.toolTempPath);
  if (
    path.basename(codexHomePath) !== 'codex-home' ||
    path.basename(toolTempPath) !== 'tool-temp' ||
    !samePath(path.dirname(codexHomePath), tempRoot) ||
    !samePath(path.dirname(toolTempPath), tempRoot)
  ) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The isolated provider runtime cleanup paths escaped their disposable root.',
    );
  }
  const rootInfo = await lstatOrNull(tempRoot);
  if (rootInfo === null) {
    if (
      (await lstatOrNull(codexHomePath)) !== null ||
      (await lstatOrNull(toolTempPath)) !== null
    ) {
      throw new WindowsSandboxBoundaryError(
        'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
        'Provider runtime content exists without its registered disposable root.',
      );
    }
    return;
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The provider runtime disposable root was replaced.',
    );
  }
  const resolvedRoot = await realpath(tempRoot);
  if (!samePath(resolvedRoot, tempRoot)) {
    throw new WindowsSandboxBoundaryError(
      'PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE',
      'The provider runtime disposable root resolves unexpectedly.',
    );
  }
  await removeRealRuntimeDirectory(codexHomePath, 'codex-home', resolvedRoot);
  await removeRealRuntimeDirectory(toolTempPath, 'tool-temp', resolvedRoot);
}
