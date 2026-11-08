/**
 * Each project's git remote as a key (#3066), for suggesting a link with the
 * same project on another machine. Only the key leaves this module: the URL
 * may hold credentials.
 *
 * Best effort and off every critical path: `git config` with a short timeout,
 * a few at a time, nothing logged (most folders have no `origin`, and that's
 * fine), each answer kept for a minute. A snapshot takes what's known now and
 * starts a refresh for the rest, so it never waits on git.
 */
import { execFile } from 'child_process';
import { normalizeGitRemote } from '../../shared/git-remote';

const TTL_MS = 60_000;
const GIT_TIMEOUT_MS = 3_000;
const CONCURRENCY = 4;

type Entry = { key: string | null; at: number };
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<string | null>>();
let running = 0;
const waiting: Array<() => void> = [];

/** Runs git for one folder; the reader is swapped in tests. */
let readOrigin = (cwd: string): Promise<string | null> => new Promise((resolve) => {
  execFile('git', ['config', '--get', 'remote.origin.url'], { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
    resolve(err ? null : String(stdout).trim() || null);
  });
});

async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

function refresh(projectPath: string, now: number): Promise<string | null> {
  const pending = inflight.get(projectPath);
  if (pending) return pending;
  const run = slot(async () => {
    let key: string | null = null;
    try {
      key = normalizeGitRemote(await readOrigin(projectPath));
    } catch {
      // telemetry-exempt: no key means no suggestion, which is fine
      key = null;
    }
    cache.set(projectPath, { key, at: now });
    return key;
  }).finally(() => inflight.delete(projectPath));
  inflight.set(projectPath, run);
  return run;
}

const fresh = (entry: Entry | undefined, now: number): entry is Entry => !!entry && now - entry.at < TTL_MS;

/** Keys for the projects that have a git remote, by project id, read now where they're not known. */
export async function repoKeysFor(projects: ReadonlyArray<{ id: string; path: string }>, now = Date.now()): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(projects.map(async (p) => {
    const entry = cache.get(p.path);
    const key = fresh(entry, now) ? entry.key : await refresh(p.path, now);
    if (key) out[p.id] = key;
  }));
  return out;
}

/** The keys known now, without waiting; projects not known (or stale) are read in the background for next time. */
export function cachedRepoKeys(projects: ReadonlyArray<{ id: string; path: string }>, now = Date.now()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of projects) {
    const entry = cache.get(p.path);
    if (!fresh(entry, now)) void refresh(p.path, now);
    if (entry?.key) out[p.id] = entry.key;
  }
  return out;
}

/** For tests. */
export function _resetRepoKeysForTesting(reader?: (cwd: string) => Promise<string | null>): void {
  cache.clear();
  inflight.clear();
  if (reader) readOrigin = reader;
}
