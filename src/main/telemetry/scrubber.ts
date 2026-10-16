/**
 * Last-line-of-defense string scrubber (spec §5.3). Runs over every string
 * attribute and every sanitized stack trace in the export pipeline.
 */

export interface ScrubberContext {
  homeDir?: string;
  username?: string;
  hostname?: string;
}

export type Scrubber = (input: string) => string;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Literal plus JSON-escaped (doubled backslash) spellings of a value. */
function literalVariants(value: string): string[] {
  const variants = new Set([value, value.replace(/\\/g, '\\\\'), value.replace(/\\/g, '/')]);
  return [...variants].sort((a, b) => b.length - a.length);
}

function literalPattern(value: string, wordBounded: boolean): RegExp {
  const body = literalVariants(value).map(escapeRegExp).join('|');
  return wordBounded
    ? new RegExp(`(?<![A-Za-z0-9_.-])(?:${body})(?![A-Za-z0-9_-])`, 'gi')
    : new RegExp(`(?:${body})`, 'gi');
}

const URL_RE = /\b(?:file|https?|wss?|ftp):\/\/[^\s"'<>]*/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// \\?\C:\..., \\.\pipe\..., \\server\share\...
const WIN_DEVICE_OR_UNC_RE = /\\\\[?.]\\[^\s"'<>|]+|\\\\[^\s\\"'<>|]+\\[^\s"'<>|]*/g;
// C:\Users\..., c:/Users/..., also JSON-escaped C:\\Users\\...
const WIN_DRIVE_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]*/g;
const TILDE_RE = /(?<![\w/])~[\\/][^\s"'<>]*/g;
const POSIX_RE = /(?:\/[^\s/:"'<>]+){2,}\/?/g;
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g;
const IPV6_RE = /(?<![\w:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?)(?![\w:])/g;

export function createScrubber(ctx: ScrubberContext = {}): Scrubber {
  const home = ctx.homeDir && ctx.homeDir.length > 1 ? literalPattern(ctx.homeDir, false) : null;
  // Short usernames ("a", "me") would shred ordinary words; only scrub 3+ chars.
  const user = ctx.username && ctx.username.length >= 3 ? literalPattern(ctx.username, true) : null;
  const host = ctx.hostname && ctx.hostname.length >= 3 ? literalPattern(ctx.hostname, true) : null;

  return (input: string): string => {
    if (!input) return input;
    let out = input;
    out = out.replace(URL_RE, '<url>');
    out = out.replace(EMAIL_RE, '<email>');
    if (home) out = out.replace(home, '<home>');
    out = out.replace(WIN_DEVICE_OR_UNC_RE, '<path>');
    out = out.replace(WIN_DRIVE_RE, '<path>');
    out = out.replace(TILDE_RE, '<path>');
    out = out.replace(POSIX_RE, '<path>');
    out = out.replace(IPV4_RE, '<ip>');
    out = out.replace(IPV6_RE, (match) => (match === '::' ? match : '<ip>'));
    if (host) out = out.replace(host, '<host>');
    if (user) out = out.replace(user, '<user>');
    return out;
  };
}

const FRAME_RE = /^\s*at\s+(?:(.*?)\s+\()?(.*?)(?::(\d+))?(?::(\d+))?\)?\s*$/;

/**
 * Reduce a stack trace to sanitized frames: the first line (which carries the
 * error message) is dropped, each frame keeps its function name and only the
 * file's basename with line/column, and the result is scrubbed again.
 */
export function sanitizeStack(stack: string | undefined, scrub: Scrubber, maxFrames = 30): string | undefined {
  if (!stack) return undefined;
  const frames: string[] = [];
  for (const line of stack.split(/\r?\n/)) {
    if (frames.length >= maxFrames) break;
    const m = FRAME_RE.exec(line);
    if (!m || !/^\s*at\s/.test(line)) continue;
    const fn = m[1] ? m[1].replace(/[^\w$.<>[\] -]/g, '') : '';
    const location = m[2] ?? '';
    const base = location.split(/[\\/]/).pop() ?? '';
    const file = /^[\w.-]+$/.test(base) ? base : '<anonymous>';
    const pos = m[3] ? `:${m[3]}${m[4] ? `:${m[4]}` : ''}` : '';
    frames.push(fn ? `at ${fn} (${file}${pos})` : `at ${file}${pos}`);
  }
  if (frames.length === 0) return undefined;
  return scrub(frames.join('\n'));
}
