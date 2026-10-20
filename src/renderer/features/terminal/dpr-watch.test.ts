import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { onDevicePixelRatioChange, DPR_REFIT_DEBOUNCE_MS } from './dpr-watch';

interface FakeMql {
  query: string;
  listeners: Set<() => void>;
}

let queries: FakeMql[] = [];
let originalMatchMedia: typeof window.matchMedia;

function setRatio(ratio: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
}

/** Simulate the browser firing `change` on every query that has listeners. */
function fireChange(): void {
  for (const q of [...queries]) for (const l of [...q.listeners]) l();
}

function activeQueries(): FakeMql[] {
  return queries.filter((q) => q.listeners.size > 0);
}

describe('onDevicePixelRatioChange', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    queries = [];
    setRatio(1);
    originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => {
      const q: FakeMql = { query, listeners: new Set() };
      queries.push(q);
      return {
        media: query,
        addEventListener: (_: string, cb: () => void) => q.listeners.add(cb),
        removeEventListener: (_: string, cb: () => void) => q.listeners.delete(cb),
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.useRealTimers();
  });

  it('shares one media query across subscribers and tears it down with the last one', () => {
    const off1 = onDevicePixelRatioChange(vi.fn());
    const off2 = onDevicePixelRatioChange(vi.fn());
    expect(activeQueries()).toHaveLength(1);
    expect(activeQueries()[0].query).toBe('(resolution: 1dppx)');
    off1();
    expect(activeQueries()).toHaveLength(1);
    off2();
    expect(activeQueries()).toHaveLength(0);
  });

  it('calls each subscriber once per debounced change with from/to', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onDevicePixelRatioChange(a);
    const offB = onDevicePixelRatioChange(b);

    setRatio(1.5);
    fireChange();
    // A burst of changes (e.g. dragging across a monitor seam) coalesces.
    setRatio(2);
    fireChange();
    expect(a).not.toHaveBeenCalled();

    vi.advanceTimersByTime(DPR_REFIT_DEBOUNCE_MS);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(1, 2);
    expect(b).toHaveBeenCalledTimes(1);
    offA();
    offB();
  });

  it('re-arms the query for the new ratio after each change', () => {
    const listener = vi.fn();
    const off = onDevicePixelRatioChange(listener);

    setRatio(1.25);
    fireChange();
    expect(activeQueries()).toHaveLength(1);
    expect(activeQueries()[0].query).toBe('(resolution: 1.25dppx)');
    vi.advanceTimersByTime(DPR_REFIT_DEBOUNCE_MS);

    setRatio(1);
    fireChange();
    expect(activeQueries()[0].query).toBe('(resolution: 1dppx)');
    vi.advanceTimersByTime(DPR_REFIT_DEBOUNCE_MS);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(1.25, 1);
    off();
  });

  it('skips subscribers when the ratio settles back where it started', () => {
    const listener = vi.fn();
    const off = onDevicePixelRatioChange(listener);
    setRatio(2);
    fireChange();
    setRatio(1);
    fireChange();
    vi.advanceTimersByTime(DPR_REFIT_DEBOUNCE_MS);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('drops a pending callback when the last subscriber leaves', () => {
    const listener = vi.fn();
    const off = onDevicePixelRatioChange(listener);
    setRatio(2);
    fireChange();
    off();
    vi.advanceTimersByTime(DPR_REFIT_DEBOUNCE_MS);
    expect(listener).not.toHaveBeenCalled();
  });

  it('is a no-op without matchMedia', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const off = onDevicePixelRatioChange(vi.fn());
    expect(() => off()).not.toThrow();
  });
});
