import { execSync } from 'child_process';

let cachedShellEnv: Record<string, string> | null = null;

/** Source the user's login shell to get the full environment.
 *  Packaged macOS apps launched from Finder/Dock only get a minimal PATH. */
function getShellEnv(): Record<string, string> {
  if (cachedShellEnv) return cachedShellEnv;
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
