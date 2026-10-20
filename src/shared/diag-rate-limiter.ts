/**
 * Per-key line budget for diagnostic logging: at most `maxPerWindow` lines per
 * key in any `windowMs`, with everything held back counted and reported as
 * `suppressed` on the next line that gets through (the same rule `ui:perf`
 * uses). Pure, so main and renderer share it.
 */
export interface DiagRateLimiter {
  /**
   * Whether a line for `key` may be written now. Returns the number of lines
   * suppressed for this key since the last one written (0 or more), or
   * `null` when this line is suppressed.
   */
  take(key: string): number | null;
  /** Drop the state of every key starting with `prefix`. */
  forget(prefix: string): void;
}

export function createDiagRateLimiter(
  maxPerWindow: number,
  windowMs: number,
  now: () => number = Date.now,
): DiagRateLimiter {
  const sent = new Map<string, number[]>();
  const held = new Map<string, number>();
  return {
    take(key) {
      const t = now();
      const times = (sent.get(key) ?? []).filter((at) => t - at < windowMs);
      if (times.length >= maxPerWindow) {
        sent.set(key, times);
        held.set(key, (held.get(key) ?? 0) + 1);
        return null;
      }
      times.push(t);
      sent.set(key, times);
      const suppressed = held.get(key) ?? 0;
      held.delete(key);
      return suppressed;
    },
    forget(prefix) {
      for (const map of [sent, held]) {
        for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
      }
    },
  };
}
