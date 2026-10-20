/**
 * GitHub pull request, issue and commit references in chat (#2351). The
 * renderer asks main for one on hover; main looks it up through the user's
 * `gh` (github.com only) and caches the answer.
 */

/** `ref` is a number that may be either an issue or a pull request (`#123`). */
export type GithubRefKind = 'pull' | 'issue' | 'commit' | 'ref';

export type GithubRefState = 'draft' | 'open' | 'merged' | 'closed';

export type GithubChecks = 'passing' | 'failing' | 'pending';

export interface GithubRefDetails {
  kind: 'pull' | 'issue' | 'commit';
  title: string;
  /** Absent for commits. */
  state?: GithubRefState;
  author?: string;
  /** ISO time: last update for issues and pull requests, commit time for commits. */
  updatedAt?: string;
  /** The status check rollup of a pull request's head or a commit, when it has one. */
  checks?: GithubChecks;
}

/** `unavailable`: gh missing, signed out, rate-limited, offline or the repo is private to this user. */
export type GithubRefResult = { ok: true; details: GithubRefDetails } | { ok: false; reason: 'unavailable' | 'not_found' };

/** Owner and repo names GitHub allows: letters, digits, `.`, `-`, `_`. */
export const GITHUB_NAME_RE = /^[\w.-]{1,100}$/;
export const GITHUB_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Whether `repo` is a valid "owner/name". */
export function isGithubRepo(repo: string): boolean {
  const [owner, name, extra] = repo.split('/');
  return extra === undefined && !!owner && !!name && GITHUB_NAME_RE.test(owner) && GITHUB_NAME_RE.test(name)
    && owner !== '.' && owner !== '..' && name !== '.' && name !== '..';
}
