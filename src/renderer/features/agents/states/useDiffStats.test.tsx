import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { matchStat, mergeFileStats, useDiffStats } from './useDiffStats';

const e = (path: string, added = 1) => ({ path, added, removed: 0, binary: false });

describe('matchStat', () => {
  it('prefers an exact repo-relative match', () => {
    expect(matchStat('src/a.ts', [e('lib/src/a.ts', 9), e('src/a.ts', 2)])).toMatchObject({ added: 2 });
  });

  it('matches a suffix only on a path-segment boundary', () => {
    expect(matchStat('/wt/src/a.ts', [e('src/a.ts')])).toBeDefined();
    expect(matchStat('src/ba.ts', [e('a.ts')])).toBeUndefined();
  });

  it('prefers the longest suffix match', () => {
    expect(matchStat('/wt/src/a.ts', [e('a.ts', 1), e('src/a.ts', 2)])).toMatchObject({ added: 2 });
    expect(matchStat('/wt/src/a.ts', [e('src/a.ts', 2), e('a.ts', 1)])).toMatchObject({ added: 2 });
  });

  it('gives no stats for an ambiguous suffix', () => {
    expect(matchStat('index.ts', [e('src/a/index.ts'), e('src/b/index.ts')])).toBeUndefined();
  });

  it('mergeFileStats keeps every run path, with sizes where known', () => {
    expect(mergeFileStats(['src/a.ts', 'gone.ts'], [e('src/a.ts', 4)])).toEqual([
      { path: 'src/a.ts', added: 4, removed: 0, binary: false },
      { path: 'gone.ts' },
    ]);
  });
});

describe('useDiffStats', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces ticks during a call into one more run instead of cancelling it', async () => {
    let resolve: (v: unknown) => void = () => {};
    const diffNumstat = vi.fn(() => new Promise((r) => { resolve = r; }));
    window.clubhouse.git.diffNumstat = diffNumstat as never;
    const { result, rerender } = renderHook(({ k }) => useDiffStats('/wt', 'abc', k), { initialProps: { k: 0 } });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(diffNumstat).toHaveBeenCalledTimes(1);

    // Ticks while the call is in flight don't start another call or drop the answer
    rerender({ k: 1 });
    rerender({ k: 2 });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(diffNumstat).toHaveBeenCalledTimes(1);
    await act(async () => { resolve([e('src/a.ts', 7)]); await Promise.resolve(); });
    expect(result.current).toEqual([e('src/a.ts', 7)]);

    // ...and one follow-up run picks up what changed meanwhile
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(diffNumstat).toHaveBeenCalledTimes(2);
  });
});
