import { GITHUB_SHA_RE, isGithubRepo, type GithubRefKind } from '../../../../../shared/github-ref';

/**
 * Links in agent text (#2351): http(s) URLs, GitHub pull request, issue and
 * commit URLs, `owner/repo#123`, and bare `#123` when the project has a
 * GitHub remote. Pure: callers decide which text is eligible (never code).
 */

export interface GithubRef {
  repo: string;
  kind: GithubRefKind;
  /** The number, or the sha for a commit. */
  id: string;
  /** The canonical github.com page. */
  href: string;
}

export type LinkToken =
  | { start: number; end: number; type: 'url'; href: string }
  | { start: number; end: number; type: 'github'; ref: GithubRef };

export interface TokenizeOptions {
  /** The project's own GitHub repo ("owner/repo"); enables bare `#123`. */
  repo?: string | null;
  /** `owner/repo#123` and `#123`; off for tool output, where `#123` is as likely a CSS color. */
  shorthand?: boolean;
}

function githubHref(repo: string, kind: GithubRefKind, id: string): string {
  const path = kind === 'commit' ? 'commit' : kind === 'pull' ? 'pull' : 'issues';
  return `https://github.com/${repo}/${path}/${id}`;
}

export function makeGithubRef(repo: string, kind: GithubRefKind, id: string): GithubRef {
  return { repo, kind, id, href: githubHref(repo, kind, id) };
}

/**
 * The GitHub reference a URL points at: github.com/o/r/pull/N (and its
 * subpages), /issues/N, /commit/sha. Null for anything else, other hosts
 * (GitHub Enterprise included) and URLs with credentials or a port.
 */
export function parseGithubUrl(href: string): GithubRef | null {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    // telemetry-exempt: not a URL; the text stays as it is.
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.port) return null;
  if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return null;
  const [owner, name, section, id] = u.pathname.split('/').filter(Boolean);
  if (!owner || !name || !section || !id) return null;
  const repo = `${owner}/${name}`;
  if (!isGithubRepo(repo)) return null;
  if ((section === 'pull' || section === 'issues') && /^\d{1,9}$/.test(id) && Number(id) > 0) {
    return makeGithubRef(repo, section === 'pull' ? 'pull' : 'issue', String(Number(id)));
  }
  if (section === 'commit' && GITHUB_SHA_RE.test(id)) return makeGithubRef(repo, 'commit', id.toLowerCase());
  return null;
}

/** How a reference reads inline: `#12` in the project's own repo, `owner/repo#12` elsewhere, `abc1234` for commits. */
export function githubLabel(ref: GithubRef, projectRepo?: string | null): string {
  const own = !!projectRepo && projectRepo.toLowerCase() === ref.repo.toLowerCase();
  if (ref.kind === 'commit') return own ? ref.id.slice(0, 7) : `${ref.repo}@${ref.id.slice(0, 7)}`;
  return own ? `#${ref.id}` : `${ref.repo}#${ref.id}`;
}

// A URL runs to whitespace or a quote/bracket that can't be in one unescaped.
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// `owner/repo#123`, not part of a longer path (`src/a/b#1`, `./a#1`, `~/a#1`).
const SHORT_REPO_RE = /(?<![\w./~\\:@-])([\w.-]{1,100})\/([\w.-]{1,100})#(\d{1,9})(?![\w-])/g;
// `#123` as its own word: not `a#1`, `&#123;`, `/#1`, `##1`, nor `#123abc`.
const BARE_RE = /(?<![\w&/#\\-])#(\d{1,9})(?![\w-])/g;

/** Trailing punctuation that ends a sentence rather than the URL; a `)` stays when the URL opened one. */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url[url.length - 1];
    if (/[.,;:!?*_~]/.test(last)) { url = url.slice(0, -1); continue; }
    if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    if (last === ']' && (url.match(/\[/g)?.length ?? 0) < (url.match(/\]/g)?.length ?? 0)) { url = url.slice(0, -1); continue; }
    return url;
  }
}

/** Tokens in `text`, in order and never overlapping. */
export function findLinkTokens(text: string, options: TokenizeOptions = {}): LinkToken[] {
  const tokens: LinkToken[] = [];
  const taken = (start: number, end: number) => tokens.some((t) => start < t.end && end > t.start);

  for (const m of text.matchAll(URL_RE)) {
    const href = trimUrl(m[0]);
    const start = m.index!;
    const end = start + href.length;
    if (!/^https?:\/\/[^/?#\s]+/i.test(href)) continue;
    const ref = parseGithubUrl(href);
    tokens.push(ref ? { start, end, type: 'github', ref } : { start, end, type: 'url', href });
  }
  if (options.shorthand) {
    for (const m of text.matchAll(SHORT_REPO_RE)) {
      const start = m.index!;
      const end = start + m[0].length;
      const repo = `${m[1]}/${m[2]}`;
      if (taken(start, end) || !isGithubRepo(repo) || Number(m[3]) === 0) continue;
      tokens.push({ start, end, type: 'github', ref: makeGithubRef(repo, 'ref', String(Number(m[3]))) });
    }
    if (options.repo && isGithubRepo(options.repo)) {
      for (const m of text.matchAll(BARE_RE)) {
        const start = m.index!;
        const end = start + m[0].length;
        if (taken(start, end) || Number(m[1]) === 0) continue;
        tokens.push({ start, end, type: 'github', ref: makeGithubRef(options.repo, 'ref', String(Number(m[1]))) });
      }
    }
  }
  return tokens.sort((a, b) => a.start - b.start);
}
