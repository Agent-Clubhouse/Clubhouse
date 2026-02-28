import { execSync } from 'child_process';

let cachedShellEnv: Record<string, string> | null = null;

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
    const env: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        env[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    cachedShellEnv = { ...process.env, ...env } as Record<string, string>;
  } catch {
    cachedShellEnv = { ...process.env } as Record<string, string>;
  }
  return cachedShellEnv;
}

/** Returns the user's full shell environment — use for spawning processes. */
export function getShellEnvironment(): Record<string, string> {
  return getShellEnv();
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
