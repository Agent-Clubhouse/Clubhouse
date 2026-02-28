import { execSync, execFile } from 'child_process';

let cachedShellEnv: Record<string, string> | null = null;

/** Parse raw `env` output into a key-value record */
function parseEnvOutput(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      env[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return env;
}

/** Source the user's login shell to get the full environment.
 *  Packaged macOS apps launched from Finder/Dock only get a minimal PATH.
 *  On Windows this isn't needed — the full environment is already available. */
function getShellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;

  if (process.platform === 'win32') {
    cachedShellEnv = { ...process.env } as Record<string, string>;
    return cachedShellEnv;
  }

  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const raw = execSync(`${shell} -ilc 'env'`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    cachedShellEnv = { ...process.env, ...parseEnvOutput(raw) } as Record<string, string>;
  } catch {
    cachedShellEnv = { ...process.env } as Record<string, string>;
  }
  return cachedShellEnv;
}

/** Returns the user's full shell environment — use for spawning processes. */
export function getShellEnvironment(): Record<string, string> {
  return getShellEnv();
}

/** Pre-warm the shell environment cache asynchronously.
 *  Call this early in app startup so the cache is populated before the first
 *  agent wake. Uses execFile (non-blocking) instead of execSync so it doesn't
 *  block the main process during startup. */
export function preWarmShellEnvironment(): void {
  if (cachedShellEnv || process.platform === 'win32') {
    // Already cached or not needed on Windows
    if (!cachedShellEnv && process.platform === 'win32') {
      cachedShellEnv = { ...process.env } as Record<string, string>;
    }
    return;
  }

  const shell = process.env.SHELL || '/bin/zsh';
  execFile(shell, ['-ilc', 'env'], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
    // Don't overwrite if getShellEnv() was called synchronously while we were waiting
    if (cachedShellEnv) return;
    if (err) {
      cachedShellEnv = { ...process.env } as Record<string, string>;
    } else {
      cachedShellEnv = { ...process.env, ...parseEnvOutput(stdout) } as Record<string, string>;
    }
  });
}

/** Clear the cached shell environment so the next getShellEnvironment() call
 *  re-sources the user's login shell.  Useful when env vars may have changed
 *  since the app launched (e.g. user added an API key to their shell config). */
export function invalidateShellEnvironmentCache(): void {
  cachedShellEnv = null;
}

/** Returns the platform-appropriate default shell. */
export function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/zsh';
}
