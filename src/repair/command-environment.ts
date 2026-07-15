import {
  lstat,
  mkdir,
  open,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

export interface IsolatedCommandEnvironment {
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimePath: string;
  cleanup(): Promise<void>;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function writeEmptyFile(filePath: string): Promise<void> {
  const handle = await open(filePath, 'wx');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function createIsolatedCommandEnvironment(
  tempRoot: string,
  port: number,
): Promise<IsolatedCommandEnvironment> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError('Isolated command environment requires a valid TCP port.');
  }
  const normalizedRoot = path.resolve(tempRoot);
  const resolvedRoot = await realpath(normalizedRoot);
  if (!samePath(resolvedRoot, normalizedRoot)) {
    throw new Error(
      'PP_REPAIR_COMMAND_ENVIRONMENT_UNSAFE: disposable root resolves unexpectedly.',
    );
  }
  const runtimePath = path.join(resolvedRoot, 'command-runtime');
  let runtimeInfo: Awaited<ReturnType<typeof lstat>>;
  let runtimeCreated = false;
  try {
    await mkdir(runtimePath, { recursive: false, mode: 0o700 });
    runtimeCreated = true;
    [runtimeInfo] = await Promise.all([
      lstat(runtimePath),
      writeEmptyFile(path.join(runtimePath, 'user.npmrc')),
      writeEmptyFile(path.join(runtimePath, 'global.npmrc')),
    ]);
  } catch (error) {
    if (runtimeCreated) {
      try {
        const [info, resolvedRuntime] = await Promise.all([
          lstat(runtimePath),
          realpath(runtimePath),
        ]);
        if (
          info.isDirectory() &&
          !info.isSymbolicLink() &&
          samePath(resolvedRuntime, runtimePath) &&
          samePath(path.dirname(resolvedRuntime), resolvedRoot)
        ) {
          await rm(resolvedRuntime, { force: true, recursive: true });
        }
      } catch {
        // Preserve the original setup failure; recovery will retire the
        // disposable worktree root through its stronger worktree boundary.
      }
    }
    throw error;
  }
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()) {
    throw new Error(
      'PP_REPAIR_COMMAND_ENVIRONMENT_UNSAFE: runtime root is not one real directory.',
    );
  }

  const allowed = [
    'APPDATA',
    'COMSPEC',
    'HOME',
    'LOCALAPPDATA',
    'NODE_EXTRA_CA_CERTS',
    'PATH',
    'PATHEXT',
    'PLAYWRIGHT_BROWSERS_PATH',
    'SYSTEMDRIVE',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'WINDIR',
  ] as const;
  const environment: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      environment[key] = process.env[key];
    }
  }
  environment.CI = '1';
  environment.NO_COLOR = '1';
  environment.PORT = String(port);
  environment.PROMISEPROOF_BASE_URL = `http://127.0.0.1:${port}`;
  environment.NPM_CONFIG_USERCONFIG = path.join(runtimePath, 'user.npmrc');
  environment.NPM_CONFIG_GLOBALCONFIG = path.join(runtimePath, 'global.npmrc');
  environment.NPM_CONFIG_CACHE = path.join(runtimePath, 'npm-cache');
  environment.NPM_CONFIG_REGISTRY = 'https://registry.npmjs.org/';
  environment.NPM_CONFIG_AUDIT = 'false';
  environment.NPM_CONFIG_FUND = 'false';
  environment.NPM_CONFIG_IGNORE_SCRIPTS = 'true';
  environment.NPM_CONFIG_UPDATE_NOTIFIER = 'false';

  let cleaned = false;
  return Object.freeze({
    environment: Object.freeze(environment),
    runtimePath,
    cleanup: async () => {
      if (cleaned) {
        return;
      }
      const info = await lstat(runtimePath);
      const resolvedRuntime = await realpath(runtimePath);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePath(resolvedRuntime, runtimePath) ||
        !samePath(path.dirname(resolvedRuntime), resolvedRoot)
      ) {
        throw new Error(
          'PP_REPAIR_COMMAND_ENVIRONMENT_UNSAFE: refusing to clean a replaced runtime root.',
        );
      }
      await rm(resolvedRuntime, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 50,
      });
      cleaned = true;
    },
  });
}
