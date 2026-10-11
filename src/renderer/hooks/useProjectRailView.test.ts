import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ACTIVITY_SETTLE_MS, useSettledSet } from './useProjectRailView';

describe('useSettledSet', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('starts with the initial membership immediately', () => {
    const { result } = renderHook(() => useSettledSet(new Set(['a']), false));
    expect([...result.current]).toEqual(['a']);
  });

  it('commits a change only after it holds for the settle delay', () => {
    const { result, rerender } = renderHook(({ raw }) => useSettledSet(raw, false), {
      initialProps: { raw: new Set<string>() as ReadonlySet<string> },
    });
    rerender({ raw: new Set(['a']) });
    act(() => { vi.advanceTimersByTime(ACTIVITY_SETTLE_MS - 1); });
    expect(result.current.size).toBe(0);
    act(() => { vi.advanceTimersByTime(1); });
    expect([...result.current]).toEqual(['a']);
  });

  it('drops a transient flicker that reverts within the delay', () => {
    const { result, rerender } = renderHook(({ raw }) => useSettledSet(raw, false), {
      initialProps: { raw: new Set(['a']) as ReadonlySet<string> },
    });
    const initial = result.current;
    rerender({ raw: new Set<string>() });
    act(() => { vi.advanceTimersByTime(ACTIVITY_SETTLE_MS / 2); });
    rerender({ raw: new Set(['a']) });
    act(() => { vi.advanceTimersByTime(ACTIVITY_SETTLE_MS * 2); });
    expect(result.current).toBe(initial);
  });

  it('holds changes while frozen and applies them after the freeze lifts', () => {
    const { result, rerender } = renderHook(({ raw, frozen }) => useSettledSet(raw, frozen), {
      initialProps: { raw: new Set<string>() as ReadonlySet<string>, frozen: true },
    });
    rerender({ raw: new Set(['a']), frozen: true });
    act(() => { vi.advanceTimersByTime(ACTIVITY_SETTLE_MS * 5); });
    expect(result.current.size).toBe(0);
    rerender({ raw: new Set(['a']), frozen: false });
    act(() => { vi.advanceTimersByTime(ACTIVITY_SETTLE_MS); });
    expect([...result.current]).toEqual(['a']);
  });
});
