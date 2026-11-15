import * as fs from 'fs';
import * as path from 'path';
import { buildWindowsCmdLine, resolveNodeShim, windowsLauncherCandidates, WINDOWS_BATCH_RE } from './windows-launcher';

interface ProcessLaunch {
  binary: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

/** Match Node's case-insensitive Windows environment lookup. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).sort().find((k) => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/** Resolve files only, without evaluating a command in cmd.exe or `where`. */
function resolveWindowsExecutable(binary: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const hasPath = /[/\\:]/.test(binary);
  // Bare commands come only from PATH, never the plugin's project directory.
  const candidates = hasPath
    ? [path.resolve(cwd, binary)]
    : (envValue(env, 'PATH') ?? '').split(';').filter(Boolean)
      .map((dir) => path.resolve(cwd, dir.replace(/^"(.*)"$/, '$1'), binary));
  for (const candidate of candidates) {
    for (const file of windowsLauncherCandidates(candidate, envValue(env, 'PATHEXT') || '')) {
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch { /* Missing PATH entries are normal. */ }
    }
  }
  throw new Error(`Could not find Windows executable "${binary}" on PATH`);
}

/**
 * Prepare argv for execFile/spawn with shell: false. POSIX is unchanged.
 * Windows native binaries run directly; npm node shims bypass cmd.exe when
 * possible. Other batch shims use the existing #2339/#2340 quoting, including
 * the second escape layer needed when a shim forwards %*. No caller input is
 * interpreted as a command line. Batch shims cannot represent line breaks.
 */
export function resolveProcessLaunch(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ProcessLaunch {
  if (process.platform !== 'win32') return { binary, args };
  if ([binary, ...args].some((a) => a.includes('\0'))) {
    throw new Error('Cannot launch a Windows process with a NUL character');
  }
  const resolved = resolveWindowsExecutable(binary, env, cwd);
  if (!WINDOWS_BATCH_RE.test(resolved)) return { binary: resolved, args };

  const shim = resolveNodeShim(resolved);
  if (shim) {
    const node = shim.node === 'node' ? 'node.exe' : shim.node;
    return { binary: resolveWindowsExecutable(node, env, cwd), args: [shim.script, ...args] };
  }
  if ([resolved, ...args].some((a) => /[\r\n]/.test(a))) {
    throw new Error('Cannot launch a Windows batch shim with an argument containing a line break');
  }
  return {
    // Use the system command interpreter, not a project-local cmd.exe.
    binary: path.join(envValue(env, 'SYSTEMROOT') || 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', `"${buildWindowsCmdLine(resolved, args)}"`],
    windowsVerbatimArguments: true,
  };
}
