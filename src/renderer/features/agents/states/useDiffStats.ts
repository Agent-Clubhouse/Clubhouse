import { useEffect, useMemo, useRef, useState } from 'react';
import type { GitNumstatEntry } from '../../../../shared/types';
import type { ChangedFileStat } from './RunMonitor';

/** Minimum gap between numstat calls while a run is busy. */
const REFRESH_THROTTLE_MS = 2_000;

/**
 * `git diff --numstat` for the run's directory against the sha it started
 * from (#2033), refreshed whenever `refreshKey` changes (post-tool events),
 * at most every two seconds.
 */
export function useDiffStats(cwd: string | undefined, base: string | undefined, refreshKey: unknown): GitNumstatEntry[] {
  const [entries, setEntries] = useState<GitNumstatEntry[]>([]);
  // One call at a time, always for the latest cwd and base: a tick during a
  // call queues one more run instead of cancelling it, so a busy run still
  // gets fresh numbers.
  const st = useRef({
    cwd: undefined as string | undefined,
    base: undefined as string | undefined,
    inFlight: false,
    pending: false,
    lastRun: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
    mounted: true,
  }).current;

  const runRef = useRef<() => void>(() => {});
  runRef.current = () => {
    if (st.timer) return;
    const wait = Math.max(0, REFRESH_THROTTLE_MS - (Date.now() - st.lastRun));
    st.timer = setTimeout(async () => {
      st.timer = null;
      if (!st.cwd || !st.mounted) return;
      if (st.inFlight) { st.pending = true; return; }
      const cwdAtCall = st.cwd;
      const baseAtCall = st.base;
      st.inFlight = true;
      st.lastRun = Date.now();
      try {
        const result = await window.clubhouse.git.diffNumstat(cwdAtCall, baseAtCall);
        // Drop only an answer for a directory or base we've since left
        if (st.mounted && st.cwd === cwdAtCall && st.base === baseAtCall && Array.isArray(result)) setEntries(result);
      } catch {
        // telemetry-exempt: diff sizes are optional; rows show without them
      } finally {
        st.inFlight = false;
        if (st.pending && st.mounted) {
          st.pending = false;
          runRef.current();
        }
      }
    }, wait);
  };

  useEffect(() => {
    if (st.cwd !== cwd || st.base !== base) setEntries([]);
    st.cwd = cwd;
    st.base = base;
    if (cwd) runRef.current();
  }, [cwd, base, refreshKey, st]);

  useEffect(() => {
    st.mounted = true;
    return () => {
      st.mounted = false;
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
    };
  }, [st]);

  return entries;
}

/**
 * The numstat entry for a run path: an exact repo-relative match, else the
 * entry sharing the longest suffix on a segment boundary (so `/wt/src/a.ts`
 * picks `src/a.ts` over `a.ts`). A tie for longest (two `index.ts` files)
 * gets no stats rather than the wrong ones.
 */
export function matchStat<T extends { path: string }>(runPath: string, entries: T[]): T | undefined {
  const norm = runPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const exact = entries.find((e) => e.path === norm);
  if (exact) return exact;
  const hits = entries.filter((e) => norm.endsWith(`/${e.path}`) || e.path.endsWith(`/${norm}`));
  if (hits.length <= 1) return hits[0];
  // The shared part is the shorter of the two paths; prefer the most of it
  const shared = (e: T) => Math.min(e.path.length, norm.length);
  const best = Math.max(...hits.map(shared));
  const top = hits.filter((e) => shared(e) === best);
  return top.length === 1 ? top[0] : undefined;
}

/**
 * The files a run changed (from its transcript), with sizes from numstat.
 * numstat paths are repo-root relative; run paths are relative to its
 * directory or absolute.
 */
export function mergeFileStats(paths: string[], numstat: GitNumstatEntry[]): ChangedFileStat[] {
  return paths.map((p) => {
    const norm = p.replace(/\\/g, '/');
    const hit = matchStat(norm, numstat);
    return hit ? { path: norm, added: hit.added, removed: hit.removed, binary: hit.binary } : { path: norm };
  });
}

export function useRunFiles(paths: string[], cwd: string | undefined, base: string | undefined, refreshKey: unknown): ChangedFileStat[] {
  const numstat = useDiffStats(paths.length ? cwd : undefined, base, refreshKey);
  return useMemo(() => mergeFileStats(paths, numstat), [paths, numstat]);
}
