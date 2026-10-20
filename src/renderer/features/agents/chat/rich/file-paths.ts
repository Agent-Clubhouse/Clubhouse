/**
 * Path-like text in agent messages and tool output (rich chat content, #2350):
 * absolute POSIX and Windows paths, relative paths, `file://` URLs, each with
 * an optional `:line[:col]`. Detection is generous on purpose; a chip appears
 * only once main confirms the file exists inside the agent's folders.
 */

export interface FilePathMatch {
  start: number;
  end: number;
  /** The path as written, without the line suffix. */
  path: string;
  line?: number;
  col?: number;
}

/** Characters that end a token: whitespace, quotes, brackets, and the like. */
const TOKEN_RE = /[^\s"'`<>()[\]{}|,;]+/g;
/** Trailing punctuation that belongs to the sentence, not the path. */
const TRAILING_RE = /[.,:;!?]+$/;
/** `:12`, `:12:5` (line, column) or `:12-20` (a range: its first line). */
const LINE_RE = /^(.*?):(\d{1,7})(?:(:|-)(\d{1,7}))?$/;
/** GitHub-style `#L12` or `#L12-L20`. */
const ANCHOR_RE = /^(.*?)#L(\d{1,7})(?:-L?\d{1,7})?$/;

const WINDOWS_ABS = /^[A-Za-z]:[\\/]/;
/** A final segment with an extension that starts with a letter (`a.ts`, `notes.md`, not `v1.2`). */
const HAS_EXTENSION = /[^\\/]\.[A-Za-z][A-Za-z0-9]{0,9}$/;

function isPathLike(p: string): boolean {
  if (p.length < 2 || p.length > 1024) return false;
  if (/^file:\/\//i.test(p)) return p.length > 'file://'.length + 1;
  // Other URLs and schemes (https:, mailto:) belong to the link matcher.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(p) && !WINDOWS_ABS.test(p)) return false;
  // URLs, and email addresses (an `@` before any slash; `node_modules/@types/x` is fine).
  if (p.includes('://') || /^[^\\/]*@/.test(p)) return false;
  if (WINDOWS_ABS.test(p)) return p.length > 3;
  const segments = p.split(/[\\/]/).filter(Boolean);
  if (p.startsWith('/')) {
    // `/` alone, `/s` and similar aren't worth a lookup; a real path has depth or an extension.
    return segments.length >= 2 || HAS_EXTENSION.test(p);
  }
  if (p.startsWith('./') || p.startsWith('../') || p.startsWith('.\\') || p.startsWith('..\\') || p.startsWith('~/')) return segments.length >= 2;
  // Relative: `src/a.ts` or `src/components/Foo` (not prose like `read/write`, or dates), or a bare `package.json`.
  if (segments.length >= 2) return /[A-Za-z]/.test(p) && !/^\d+[\\/]\d+/.test(p) && (HAS_EXTENSION.test(p) || segments.length >= 3);
  // A bare name needs a real stem and extension (`notes.md`, not `e.g`).
  return /^[A-Za-z_][\w.-]*[^\\/.]\.[A-Za-z][A-Za-z0-9]{1,9}$/.test(p);
}

/** Paths in `text`, in order. */
export function findFilePaths(text: string): FilePathMatch[] {
  const out: FilePathMatch[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    let token = m[0];
    let start = m.index ?? 0;
    // Leading and trailing `*` (emphasis left in plain text). Not `_` or `~`:
    // they start real names (`__init__.py`, `~/notes.md`).
    const lead = /^\*+/.exec(token)?.[0].length ?? 0;
    token = token.slice(lead);
    start += lead;
    token = token.replace(TRAILING_RE, '').replace(/\*+$/, '').replace(TRAILING_RE, '');
    let path = token;
    let line: number | undefined;
    let col: number | undefined;
    const am = ANCHOR_RE.exec(token);
    const lm = am ? null : LINE_RE.exec(token);
    if (am && am[1]) {
      path = am[1];
      line = Number(am[2]);
    } else if (lm && lm[1] && !/^[A-Za-z]$/.test(lm[1])) {
      path = lm[1];
      line = Number(lm[2]);
      if (lm[3] === ':' && lm[4]) col = Number(lm[4]);
    }
    if (!isPathLike(path)) continue;
    out.push({ start, end: start + token.length, path, ...(line !== undefined && { line }), ...(col !== undefined && { col }) });
  }
  return out;
}

/** The whole of `text` as one path (an inline code span holding just a path), or null. */
export function wholeFilePath(text: string): FilePathMatch | null {
  const trimmed = text.trim();
  const [match] = findFilePaths(trimmed);
  return match && match.start === 0 && match.end === trimmed.length ? match : null;
}
