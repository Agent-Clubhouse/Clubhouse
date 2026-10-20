/**
 * Shared device-pixel-ratio watcher for terminals (#2326).
 *
 * Moving a window between monitors with different scaling, fractional
 * scaling changes, and browser zoom all change `devicePixelRatio`. xterm
 * re-measures its cell size on its own, but only `FitAddon.fit()` updates
 * cols/rows, and the container's CSS size often stays the same, so the
 * ResizeObserver never fires. Terminals subscribe here to refit.
 *
 * A `(resolution: Xdppx)` media query only matches the ratio it was built
 * for, so the query is re-armed with the new ratio after every change. One
 * query is shared by all subscribers, and bursts of changes are debounced
 * so each subscriber refits once, after xterm has re-measured.
 */

/** Debounce (ms) between the last DPR change and the subscriber callbacks. */
export const DPR_REFIT_DEBOUNCE_MS = 100;

export type DprChangeListener = (from: number, to: number) => void;

const listeners = new Set<DprChangeListener>();
let mql: MediaQueryList | null = null;
let settledRatio = 1;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function currentRatio(): number {
  return window.devicePixelRatio || 1;
}

function onMediaChange(): void {
  // Re-arm for the new ratio first so further changes keep firing.
  disarm();
  arm();
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const from = settledRatio;
    const to = currentRatio();
    settledRatio = to;
    if (from === to) return;
    for (const listener of [...listeners]) listener(from, to);
  }, DPR_REFIT_DEBOUNCE_MS);
}

function arm(): void {
  if (typeof window.matchMedia !== 'function') return;
  mql = window.matchMedia(`(resolution: ${currentRatio()}dppx)`);
  mql.addEventListener('change', onMediaChange);
}

function disarm(): void {
  mql?.removeEventListener('change', onMediaChange);
  mql = null;
}

/**
 * Call `listener(from, to)` once per settled DPR change. Returns an
 * unsubscribe function; the media query is torn down with the last
 * subscriber.
 */
export function onDevicePixelRatioChange(listener: DprChangeListener): () => void {
  if (listeners.size === 0) {
    settledRatio = currentRatio();
    arm();
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener) || listeners.size > 0) return;
    disarm();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
}

