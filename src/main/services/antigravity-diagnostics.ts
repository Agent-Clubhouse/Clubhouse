/**
 * What Clubhouse can say locally about an Antigravity session's diagnostics (#3800).
 *
 * The CLI version and the two log locations (Clubhouse's own `--log-file` and
 * Antigravity's `~/.gemini/antigravity-cli/log/acp-*.log`) are not sent in a
 * feedback report: Framebriar's diagnostics contract has no attribute for a
 * version or a path, and a path holds a user name. They are written to
 * Clubhouse's local log only, and shown in help so a person can attach a file
 * themselves. Paths only, never contents, and never a home folder name.
 */

/** Antigravity's documented ACP log location, https://antigravity.google/docs/ide/extensions/acp/ (read 2026-11-23). */
export const ANTIGRAVITY_ACP_LOG_GLOB = '~/.gemini/antigravity-cli/log/acp-*.log';

export interface AntigravityDiagnosticFacts {
  /** Plain `x.y.z[-pre]` from the CLI's version output; absent when it wasn't one. */
  cliVersion?: string;
  acpLogGlob: string;
  /** Clubhouse's `--log-file`, home-relative; just the file name when it is outside the home folder. */
  clubhouseLogFile?: string;
}

const VERSION = /(?<![\d.])(\d{1,4})\.(\d{1,4})\.(\d{1,6})(-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?![\w.])/;

/** The version text in `agy --version` output, or undefined. Only digits, dots and a prerelease tag survive. */
export function plainCliVersion(raw: string | undefined): string | undefined {
  const m = raw ? VERSION.exec(raw) : null;
  return m ? `${m[1]}.${m[2]}.${m[3]}${m[4] ?? ''}` : undefined;
}

/**
 * A path as `~/rest` when it is under the home folder, so the person's user name
 * is never written. Outside the home folder only the file name is kept.
 */
export function homeRelativePath(path: string, home: string, platform: NodeJS.Platform = process.platform): string {
  const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const p = slash(path);
  const h = slash(home);
  if (h && (fold(p) === fold(h) || fold(p).startsWith(`${fold(h)}/`))) return `~${p.slice(h.length)}`;
  return `<elsewhere>/${p.slice(p.lastIndexOf('/') + 1)}`;
}

export function antigravityDiagnosticFacts(input: { cliVersionOutput?: string; clubhouseLogFile?: string; home: string; platform?: NodeJS.Platform }): AntigravityDiagnosticFacts {
  const cliVersion = plainCliVersion(input.cliVersionOutput);
  return {
    ...(cliVersion && { cliVersion }),
    acpLogGlob: ANTIGRAVITY_ACP_LOG_GLOB,
    ...(input.clubhouseLogFile && { clubhouseLogFile: homeRelativePath(input.clubhouseLogFile, input.home, input.platform) }),
  };
}
