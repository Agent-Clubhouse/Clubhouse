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
  const lastRunRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    const run = async () => {
      lastRunRef.current = Date.now();
      try {
        const result = await window.clubhouse.git.diffNumstat(cwd, base);
        if (!cancelled && Array.isArray(result)) setEntries(result);
      } catch {
        // telemetry-exempt: diff sizes are optional; rows show without them
      }
    };
    const wait = REFRESH_THROTTLE_MS - (Date.now() - lastRunRef.current);
    if (wait <= 0) void run();
    else timerRef.current = setTimeout(() => { void run(); }, wait);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [cwd, base, refreshKey]);

  return entries;
}

/**
 * The files a run changed (from its transcript), with sizes from numstat.
 * numstat paths are repo-root relative; run paths are relative to its
 * directory or absolute, so they match on a path suffix.
 */
export function mergeFileStats(paths: string[], numstat: GitNumstatEntry[]): ChangedFileStat[] {
  return paths.map((p) => {
    const norm = p.replace(/\\/g, '/');
    const hit = numstat.find((e) => e.path === norm || norm.endsWith(`/${e.path}`) || e.path.endsWith(`/${norm}`));
    return hit ? { path: norm, added: hit.added, removed: hit.removed, binary: hit.binary } : { path: norm };
  });
}

export function useRunFiles(paths: string[], cwd: string | undefined, base: string | undefined, refreshKey: unknown): ChangedFileStat[] {
  const numstat = useDiffStats(paths.length ? cwd : undefined, base, refreshKey);
  return useMemo(() => mergeFileStats(paths, numstat), [paths, numstat]);
}
