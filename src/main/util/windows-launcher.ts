import * as fs from 'fs';
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

/**
 * Characters cmd.exe treats specially outside quotes (cross-spawn's set).
 * Every one is caret-escaped, quotes included, so cmd.exe never enters quote
 * mode and a `"` inside an argument can't expose what follows it. `%` needs
 * it too: `^%PATH^%` looks up a variable named `PATH^`, which is undefined,
 * so it stays literal on a command line (`%%` only collapses in batch files).
 */
const CMD_META_RE = /([()\][%!^"`<>&|;, *?])/g;

function caretEscape(s: string): string {
  return s.replace(CMD_META_RE, '^$1');
}

/**
 * Quote one argument so the MSVCRT / CommandLineToArgvW rules (node.exe and
 * most Windows programs) split it back unchanged: a quote becomes `\"`, and
 * backslashes are doubled only where they precede a quote, including the
 * closing one.
 */
export function quoteWindowsArg(arg: string): string {
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

/**
 * The cmd.exe command line that runs `binary` with `args` byte-for-byte, for
 * `cmd.exe /d /s /c "<line>"` or typing at an interactive cmd.exe prompt.
 *
 * Each argument is quoted for MSVCRT, then caret-escaped for cmd.exe. A batch
 * shim forwards its arguments with `%*`, and cmd.exe parses that line again,
 * so for `.cmd`/`.bat` the arguments are caret-escaped twice; the first parse
 * strips one layer and the shim's own line strips the other (cross-spawn does
 * the same for npm shims). The binary is only parsed once.
 *
 * Line breaks can't be expressed: cmd.exe ends the command at one.
 */
export function buildWindowsCmdLine(binary: string, args: string[]): string {
  const batch = WINDOWS_BATCH_RE.test(binary);
  const escaped = args.map((a) => {
    const once = caretEscape(quoteWindowsArg(a));
    return batch ? caretEscape(once) : once;
  });
  return [caretEscape(binary), ...escaped].join(' ');
}

/**
 * The node script line of an npm/pnpm/yarn cmd-shim, in its current
 * (`"%_prog%"  "%dp0%\…\cli.js" %*`) and older (`"%~dp0\node.exe"  "%~dp0\…" %*`,
 * `node  "%~dp0\…" %*`) forms. Only whitespace may sit between the
 * interpreter and the script; a shim that adds interpreter flags isn't
 * matched and keeps running through cmd.exe.
 */
const NODE_SHIM_RE = /(?:"%_prog%"|"%~dp0\\node\.exe"|^[ \t@]*node)[ \t]+"%(?:~dp0|dp0%)\\([^"\r\n]+\.[cm]?js)"[ \t]+%\*[ \t]*\r?$/im;

/** Shims are a few hundred bytes; anything much bigger isn't one. */
const MAX_SHIM_BYTES = 16 * 1024;

/**
 * For an npm-style `.cmd` shim that only runs a node script, the node binary
 * and script it would run, so the CLI can be spawned without cmd.exe. Uses
 * `node.exe` beside the shim when present, as the shim does, else `node` from
 * PATH. Returns null for anything else, or if the script is missing.
 */
export function resolveNodeShim(shim: string): { node: string; script: string } | null {
  if (!WINDOWS_BATCH_RE.test(shim)) return null;
  let text: string;
  try {
    if (fs.statSync(shim).size > MAX_SHIM_BYTES) return null;
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const match = NODE_SHIM_RE.exec(text);
  if (!match) return null;
  const dir = path.dirname(shim);
  const script = path.join(dir, match[1]);
  if (!fs.existsSync(script)) return null;
  const localNode = path.join(dir, 'node.exe');
  return { node: fs.existsSync(localNode) ? localNode : 'node', script };
}
