import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  controlledEnvironment,
  trustedWindowsPowerShellExecutable,
} from '../../src/repair/codex-provider.js';
import {
  cleanupIsolatedProviderRuntime,
  provisionElevatedWindowsSandbox,
  verifyElevatedWindowsSandbox,
} from '../../src/repair/windows-sandbox.js';

test(
  'real elevated Windows sandbox blocks raw egress and protected credentials',
  { skip: process.platform !== 'win32', timeout: 60_000 },
  async () => {
    const tempRoot = await realpath(
      await mkdtemp(
        path.join(tmpdir(), 'promiseproof-elevated-preflight-'),
      ),
    );
    const worktreePath = path.join(tempRoot, 'checkout');
    const codexHomePath = path.join(tempRoot, 'codex-home');
    const toolTempPath = path.join(tempRoot, 'tool-temp');
    await mkdir(path.join(worktreePath, 'src', 'client'), { recursive: true });
    await writeFile(
      path.join(worktreePath, 'src', 'client', 'main.ts'),
      'export const sandboxProbe = true;\n',
      'utf8',
    );
    try {
      const executable = trustedWindowsPowerShellExecutable();
      assert.notEqual(executable, null);
      const runtime = await provisionElevatedWindowsSandbox({
        codexHomePath,
        toolTempPath,
        worktreePath,
        trustedPowerShellExecutable: executable as string,
      });
      const environment = controlledEnvironment(codexHomePath, toolTempPath);
      const result = await verifyElevatedWindowsSandbox({
        runtime,
        worktreePath,
        trustedPowerShellExecutable: executable as string,
        cliEnvironment: environment.cli,
      });
      assert.deepEqual(result, {
        implementation: 'elevated',
        workspaceReadAllowed: true,
        sandboxSecretsReadBlocked: true,
        setupMarkerReadBlocked: true,
        commandRunnerWriteBlocked: true,
        rawNetworkEgressBlocked: true,
      });
    } finally {
      await cleanupIsolatedProviderRuntime({
        tempRoot,
        codexHomePath,
        toolTempPath,
      });
      await assert.rejects(access(codexHomePath), { code: 'ENOENT' });
      await assert.rejects(access(toolTempPath), { code: 'ENOENT' });
      await rm(worktreePath, { recursive: true, force: true, maxRetries: 3 });
      await rmdir(tempRoot);
    }
  },
);
