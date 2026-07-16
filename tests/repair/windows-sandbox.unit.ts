import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  cleanupIsolatedProviderRuntime,
  provisionElevatedWindowsSandbox,
  WindowsSandboxBoundaryError,
} from '../../src/repair/windows-sandbox.js';

const windowsOnly = { skip: process.platform !== 'win32' } as const;

function trustedPowerShellExecutable(): string {
  const systemRoot =
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
  assert.equal(typeof systemRoot, 'string');
  assert.equal(path.win32.isAbsolute(systemRoot as string), true);
  return path.win32.join(
    systemRoot as string,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

function marker(): string {
  return `${JSON.stringify(
    {
      version: 5,
      offline_username: 'CodexSandboxOffline',
      online_username: 'CodexSandboxOnline',
      created_at: '2026-01-01T00:00:00.000Z',
      proxy_ports: [],
      allow_local_binding: false,
      read_roots: [],
      write_roots: [],
    },
    null,
    2,
  )}\n`;
}

async function fixture() {
  const hostCodexHomePath = await realpath(
    await mkdtemp(path.join(tmpdir(), 'promiseproof-host-sandbox-')),
  );
  const tempRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), 'promiseproof-provider-runtime-')),
  );
  const worktreePath = path.join(tempRoot, 'checkout');
  const codexHomePath = path.join(tempRoot, 'codex-home');
  const toolTempPath = path.join(tempRoot, 'tool-temp');
  await Promise.all([
    mkdir(path.join(hostCodexHomePath, '.sandbox')),
    mkdir(path.join(hostCodexHomePath, '.sandbox-bin')),
    mkdir(path.join(hostCodexHomePath, '.sandbox-secrets')),
    mkdir(path.join(worktreePath, 'src', 'client'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(hostCodexHomePath, '.sandbox', 'setup_marker.json'),
      marker(),
      'utf8',
    ),
    writeFile(
      path.join(hostCodexHomePath, '.sandbox-secrets', 'sandbox_users.json'),
      '{"fixture":"protected-target"}\n',
      'utf8',
    ),
    writeFile(
      path.join(worktreePath, 'src', 'client', 'main.ts'),
      'export const fixture = true;\n',
      'utf8',
    ),
    copyFile(
      path.resolve(
        'node_modules',
        '@openai',
        'codex-win32-x64',
        'vendor',
        'x86_64-pc-windows-msvc',
        'codex-resources',
        'codex-command-runner.exe',
      ),
      path.join(
        hostCodexHomePath,
        '.sandbox-bin',
        'codex-command-runner-0.144.4.exe',
      ),
    ),
  ]);

  return {
    hostCodexHomePath,
    tempRoot,
    worktreePath,
    codexHomePath,
    toolTempPath,
    async cleanup() {
      await cleanupIsolatedProviderRuntime({
        tempRoot,
        codexHomePath,
        toolTempPath,
      }).catch(() => undefined);
      const junction = path.join(codexHomePath, '.sandbox-secrets');
      try {
        if ((await lstat(junction)).isSymbolicLink()) {
          await unlink(junction);
        }
      } catch {
        // The normal cleanup path already removed it.
      }
      await rm(tempRoot, { force: true, recursive: true, maxRetries: 3 });
      await rm(hostCodexHomePath, {
        force: true,
        recursive: true,
        maxRetries: 3,
      });
    },
  };
}

function errorCode(expected: string) {
  return (error: unknown) =>
    error instanceof WindowsSandboxBoundaryError && error.code === expected;
}

test(
  'copies only the pinned public runtime and unlinks protected secrets before cleanup',
  windowsOnly,
  async () => {
    const setup = await fixture();
    try {
      const runtime = await provisionElevatedWindowsSandbox({
        codexHomePath: setup.codexHomePath,
        toolTempPath: setup.toolTempPath,
        worktreePath: setup.worktreePath,
        hostCodexHomePath: setup.hostCodexHomePath,
        trustedPowerShellExecutable: trustedPowerShellExecutable(),
      });
      const [sandboxInfo, binInfo, secretsInfo, runnerBytes] = await Promise.all([
        lstat(path.join(setup.codexHomePath, '.sandbox')),
        lstat(path.join(setup.codexHomePath, '.sandbox-bin')),
        lstat(path.join(setup.codexHomePath, '.sandbox-secrets')),
        readFile(
          path.join(
            setup.codexHomePath,
            '.sandbox-bin',
            'codex-command-runner-0.144.4.exe',
          ),
        ),
      ]);
      assert.equal(sandboxInfo.isDirectory(), true);
      assert.equal(sandboxInfo.isSymbolicLink(), false);
      assert.equal(binInfo.isDirectory(), true);
      assert.equal(binInfo.isSymbolicLink(), false);
      assert.equal(secretsInfo.isSymbolicLink(), true);
      assert.equal(
        createHash('sha256').update(runnerBytes).digest('hex'),
        runtime.sandboxRunnerSha256,
      );
      assert.equal(
        await readFile(
          path.join(
            setup.hostCodexHomePath,
            '.sandbox-secrets',
            'sandbox_users.json',
          ),
          'utf8',
        ),
        '{"fixture":"protected-target"}\n',
      );

      await cleanupIsolatedProviderRuntime({
        tempRoot: setup.tempRoot,
        codexHomePath: setup.codexHomePath,
        toolTempPath: setup.toolTempPath,
      });
      await assert.rejects(access(setup.codexHomePath), { code: 'ENOENT' });
      await assert.rejects(access(setup.toolTempPath), { code: 'ENOENT' });
      assert.equal(
        await readFile(
          path.join(
            setup.hostCodexHomePath,
            '.sandbox-secrets',
            'sandbox_users.json',
          ),
          'utf8',
        ),
        '{"fixture":"protected-target"}\n',
      );
    } finally {
      await setup.cleanup();
    }
  },
);

test(
  'rejects a hard-linked host credential file before creating the runtime',
  windowsOnly,
  async () => {
    const setup = await fixture();
    const source = path.join(
      setup.hostCodexHomePath,
      '.sandbox-secrets',
      'sandbox_users.json',
    );
    const secondLink = path.join(
      setup.hostCodexHomePath,
      '.sandbox-secrets',
      'credential-copy.json',
    );
    try {
      await link(source, secondLink);
      await assert.rejects(
        provisionElevatedWindowsSandbox({
          codexHomePath: setup.codexHomePath,
          toolTempPath: setup.toolTempPath,
          worktreePath: setup.worktreePath,
          hostCodexHomePath: setup.hostCodexHomePath,
          trustedPowerShellExecutable: trustedPowerShellExecutable(),
        }),
        errorCode('PP_REPAIR_CODEX_ELEVATED_SETUP_INVALID'),
      );
      await assert.rejects(access(setup.codexHomePath), { code: 'ENOENT' });
    } finally {
      await unlink(secondLink).catch(() => undefined);
      await setup.cleanup();
    }
  },
);

test(
  'keeps provisioning diagnostics limited to a safe phase and outcome',
  windowsOnly,
  async () => {
    const setup = await fixture();
    const secretShapedPath = 'C:\\pp-secret-value-must-not-appear\\powershell.exe';
    try {
      await assert.rejects(
        provisionElevatedWindowsSandbox({
          codexHomePath: setup.codexHomePath,
          toolTempPath: setup.toolTempPath,
          worktreePath: setup.worktreePath,
          hostCodexHomePath: setup.hostCodexHomePath,
          trustedPowerShellExecutable: secretShapedPath,
        }),
        (error: unknown) => {
          assert.ok(error instanceof WindowsSandboxBoundaryError);
          assert.equal(error.code, 'PP_REPAIR_CODEX_SANDBOX_PROVISION_FAILED');
          assert.equal(
            error.safeDiagnostic,
            'phase=copy_control_acls outcome=operation_failed',
          );
          assert.match(error.message, /phase=copy_control_acls outcome=operation_failed/);
          assert.doesNotMatch(error.message, /pp-secret-value-must-not-appear/i);
          return true;
        },
      );
    } finally {
      await setup.cleanup();
    }
  },
);

test(
  'refuses recursive cleanup when an unexpected junction remains',
  windowsOnly,
  async () => {
    const setup = await fixture();
    const target = await mkdtemp(
      path.join(tmpdir(), 'promiseproof-junction-target-'),
    );
    const sentinel = path.join(target, 'sentinel.txt');
    const unexpected = path.join(setup.codexHomePath, 'unexpected-link');
    try {
      await Promise.all([
        mkdir(setup.codexHomePath),
        mkdir(setup.toolTempPath),
        writeFile(sentinel, 'preserve me\n', 'utf8'),
      ]);
      await symlink(target, unexpected, 'junction');
      await assert.rejects(
        cleanupIsolatedProviderRuntime({
          tempRoot: setup.tempRoot,
          codexHomePath: setup.codexHomePath,
          toolTempPath: setup.toolTempPath,
        }),
        errorCode('PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE'),
      );
      assert.equal(await readFile(sentinel, 'utf8'), 'preserve me\n');
      await unlink(unexpected);
      await cleanupIsolatedProviderRuntime({
        tempRoot: setup.tempRoot,
        codexHomePath: setup.codexHomePath,
        toolTempPath: setup.toolTempPath,
      });
      assert.equal(await readFile(sentinel, 'utf8'), 'preserve me\n');
    } finally {
      await unlink(unexpected).catch(() => undefined);
      await rm(target, { force: true, recursive: true, maxRetries: 3 });
      await setup.cleanup();
    }
  },
);

test(
  'refuses cleanup when the credential junction is replaced by a real directory',
  windowsOnly,
  async () => {
    const setup = await fixture();
    const replacement = path.join(setup.codexHomePath, '.sandbox-secrets');
    try {
      await Promise.all([
        mkdir(setup.codexHomePath),
        mkdir(setup.toolTempPath),
      ]);
      await mkdir(replacement);
      await assert.rejects(
        cleanupIsolatedProviderRuntime({
          tempRoot: setup.tempRoot,
          codexHomePath: setup.codexHomePath,
          toolTempPath: setup.toolTempPath,
        }),
        errorCode('PP_REPAIR_PROVIDER_RUNTIME_PATH_UNSAFE'),
      );
      await rm(replacement, { recursive: true });
      await cleanupIsolatedProviderRuntime({
        tempRoot: setup.tempRoot,
        codexHomePath: setup.codexHomePath,
        toolTempPath: setup.toolTempPath,
      });
    } finally {
      await setup.cleanup();
    }
  },
);
