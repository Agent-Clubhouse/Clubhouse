import type { GithubRefResult } from '../../../../../shared/github-ref';
import type { GithubRef } from './link-tokens';

/**
 * The renderer's side of GitHub lookups (#2351). Main caches too; this copy
 * lets a token show what's known at once and keeps one IPC call per
 * reference in flight, however many tokens are hovered.
 */

// Short: main holds answers for longer, so this only covers repeat hovers without stacking staleness.
export const CLIENT_TTL_MS = 60_000;
export const CLIENT_FAILURE_TTL_MS = 30_000;
const MAX = 300;

const results = new Map<string, { at: number; result: GithubRefResult }>();
const pending = new Map<string, Promise<GithubRefResult>>();

function keyOf(ref: GithubRef): string {
  return `${ref.repo.toLowerCase()}|${ref.kind === 'commit' ? `c:${ref.id.toLowerCase()}` : `n:${ref.id}`}`;
}

function fresh(entry: { at: number; result: GithubRefResult } | undefined, now: number): entry is { at: number; result: GithubRefResult } {
  return !!entry && now - entry.at < (entry.result.ok ? CLIENT_TTL_MS : CLIENT_FAILURE_TTL_MS);
}

/** The cached answer, if it's still fresh. */
export function peekGithubRef(ref: GithubRef, now = Date.now()): GithubRefResult | undefined {
  const entry = results.get(keyOf(ref));
  return fresh(entry, now) ? entry.result : undefined;
}

/** Look a reference up, reusing a fresh answer or a lookup already on its way. Never rejects. */
export function fetchGithubRef(ref: GithubRef, now = Date.now()): Promise<GithubRefResult> {
  const key = keyOf(ref);
  const entry = results.get(key);
  if (fresh(entry, now)) return Promise.resolve(entry.result);
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const p = Promise.resolve()
    .then(() => window.clubhouse.git.githubRef(ref.repo, ref.kind, ref.id))
    .catch((): GithubRefResult => ({ ok: false, reason: 'unavailable' }))
    .then((result) => {
      if (results.size >= MAX) results.delete(results.keys().next().value!);
      results.delete(key);
      results.set(key, { at: now, result });
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

const repos = new Map<string, Promise<string | null>>();

/** The "owner/repo" of a directory's GitHub remote. A found repo is kept for the session; none is asked again next time. */
export function resolveGithubRepo(dirPath: string): Promise<string | null> {
  let p = repos.get(dirPath);
  if (!p) {
    p = Promise.resolve()
      .then(() => window.clubhouse.git.githubRepo(dirPath))
      .catch((): null => null)
      .then((r) => {
        if (!r) repos.delete(dirPath);
        return r ?? null;
      });
    repos.set(dirPath, p);
  }
  return p;
}

/** Forget everything (tests). */
export function resetGithubRefClient(): void {
  results.clear();
  pending.clear();
  repos.clear();
}
