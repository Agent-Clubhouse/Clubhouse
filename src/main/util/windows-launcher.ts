import * as path from 'path';

/**
 * What Clubhouse can launch on Windows, shared by binary discovery
 * (findBinaryInPath) and the structured launcher (resolveStructuredSpawn) so
 * the two agree.
 *
 * - `.exe`/`.com` spawn directly.
 * - `.cmd`/`.bat` run through cmd.exe.
 * - Nothing else is runnable: an extensionless file next to an npm shim is
 *   the Unix shell script, and `.ps1` would need PowerShell, which neither
 *   launcher invokes.
 */
const WINDOWS_LAUNCHER_EXTS = ['.com', '.exe', '.bat', '.cmd'];

/** Batch shims (npm's `codex.cmd`, `copilot.cmd`, …) that only cmd.exe can run. */
export const WINDOWS_BATCH_RE = /\.(cmd|bat)$/i;

/** Windows' default PATHEXT, used when the variable is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** True when `file` has an extension Clubhouse can launch on Windows. */
export function isWindowsLauncher(file: string): boolean {
  return WINDOWS_LAUNCHER_EXTS.includes(path.extname(file).toLowerCase());
}

/**
 * Launcher extensions in PATHEXT order, like cmd.exe's own lookup, keeping
 * only those Clubhouse can launch.
 */
export function windowsLauncherExtensions(): string[] {
  const exts = (process.env.PATHEXT || DEFAULT_PATHEXT)
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => WINDOWS_LAUNCHER_EXTS.includes(e));
  const ordered = [...new Set(exts)];
  return ordered.length > 0 ? ordered : WINDOWS_LAUNCHER_EXTS;
}

/**
 * The files to try for `candidate` on Windows: itself if it already names a
 * launcher, otherwise `candidate` plus each launcher extension. The bare
 * candidate is never returned unless it is itself a launcher.
 */
export function windowsLauncherCandidates(candidate: string): string[] {
  if (isWindowsLauncher(candidate)) return [candidate];
  return windowsLauncherExtensions().map((ext) => candidate + ext);
}
