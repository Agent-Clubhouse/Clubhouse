/**
 * Path-like text in agent messages and tool output (rich chat content, #2350):
 * absolute POSIX and Windows paths, relative paths, `file://` URLs, each with
 * an optional `:line[:col]` or `#Lline`. Detection is generous on purpose; a
 * chip appears only once main confirms the file exists inside the agent's
 * folders. In prose a path ends at whitespace; a path with spaces is taken
 * whole only where its ends are unambiguous: quoted, or a whole code span
 * (#2423).
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

/** Split a `:line[:col]` or `#Lline` suffix off `token`. */
function parseLocation(token: string): { path: string; line?: number; col?: number } {
  const am = ANCHOR_RE.exec(token);
  if (am && am[1]) return { path: am[1], line: Number(am[2]) };
  const lm = am ? null : LINE_RE.exec(token);
  // `C:12` is a drive letter, not a line.
  if (lm && lm[1] && !/^[A-Za-z]$/.test(lm[1])) {
    return { path: lm[1], line: Number(lm[2]), ...(lm[3] === ':' && lm[4] && { col: Number(lm[4]) }) };
  }
  return { path: token };
}

function matchAt(start: number, token: string, loc: { path: string; line?: number; col?: number }): FilePathMatch {
  return { start, end: start + token.length, path: loc.path, ...(loc.line !== undefined && { line: loc.line }), ...(loc.col !== undefined && { col: loc.col }) };
}

/** Starts that pin a path down: absolute, home, `./` or `../`, a drive, or a `file://` URL. */
const ANCHORED_RE = /^(?:\/|~[\\/]|\.\.?[\\/]|[A-Za-z]:[\\/]|file:\/\/)/i;

/**
 * True when prose clearly names a file: its start pins it down (absolute,
 * home, `./`, a drive, `file://`) and it ends in an extension. `/tmp/CH`,
 * the first word of a spaced path in prose, is not.
 */
export function namesFileClearly(path: string): boolean {
  return ANCHORED_RE.test(path) && HAS_EXTENSION.test(path);
}

/**
 * `text` as one path that has spaces in it, when its ends are already known
 * (quoted, or a whole code span). Still strict: no newlines or tabs, no
 * space beside a separator, and a bare relative path keeps its first folder
 * free of spaces, so `npm run src/main.ts` stays a command. A non-final word
 * that is itself a path with an extension means two paths, not one.
 */
function spacedPath(text: string): { path: string; line?: number; col?: number } | null {
  if (!/ /.test(text) || /[\t\n\r"`<>|]/.test(text) || /\s[\\/]|[\\/]\s|^\s|\s$/.test(text)) return null;
  const loc = parseLocation(text);
  const { path } = loc;
  if (!ANCHORED_RE.test(path) && (/\s/.test(path.split(/[\\/]/)[0]) || !/[\\/]/.test(path))) return null;
  const words = path.split(/ +/);
  // With its punctuation and location off: `"src/a.ts:3, src/b.ts"` is a list.
  const ends = (w: string) => parseLocation(w.replace(TRAILING_RE, '')).path;
  if (words.slice(0, -1).some((w) => /[\\/]/.test(w) && HAS_EXTENSION.test(ends(w)))) return null;
  // Checked as written, with the spaces standing in for any other name character.
  return isPathLike(path.replace(/ /g, '_')) ? loc : null;
}

/** Quoted text: `"..."`, `'...'`, a backtick pair left in plain text, or curly quotes. */
const QUOTED_RE = /(?<![\w])(?:"([^"\n]{2,1024})"|'([^'\n]{2,1024})'|`([^`\n]{2,1024})`|\u201c([^\u201d\n]{2,1024})\u201d|\u2018([^\u2019\n]{2,1024})\u2019)(?![\w])/g;

/** Paths in `text`, in order. */
export function findFilePaths(text: string): FilePathMatch[] {
  const out: FilePathMatch[] = [];
  // Quoted paths with spaces first: the words inside them are not paths of their own.
  for (const m of text.matchAll(QUOTED_RE)) {
    const inner = m.slice(1).find((g) => g !== undefined) ?? '';
    const loc = spacedPath(inner);
    if (loc) out.push(matchAt((m.index ?? 0) + 1, inner, loc));
  }
  const quoted = out.slice();
  for (const m of text.matchAll(TOKEN_RE)) {
    let token = m[0];
    let start = m.index ?? 0;
    if (quoted.some((q) => start < q.end && start + token.length > q.start)) continue;
    // Leading and trailing `*` (emphasis left in plain text). Not `_` or `~`:
    // they start real names (`__init__.py`, `~/notes.md`).
    const lead = /^\*+/.exec(token)?.[0].length ?? 0;
    token = token.slice(lead);
    start += lead;
    token = token.replace(TRAILING_RE, '').replace(/\*+$/, '').replace(TRAILING_RE, '');
    const loc = parseLocation(token);
    if (!isPathLike(loc.path)) continue;
    out.push(matchAt(start, token, loc));
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * The whole of `text` as one path (an inline code span holding just a path),
 * or null. The span's ends are the path's, so it may have spaces in it.
 */
export function wholeFilePath(text: string): FilePathMatch | null {
  const trimmed = text.trim();
  const [match] = findFilePaths(trimmed);
  if (match && match.start === 0 && match.end === trimmed.length) return match;
  const loc = spacedPath(trimmed);
  return loc ? matchAt(0, trimmed, loc) : null;
}
