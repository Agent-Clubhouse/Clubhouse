/**
 * Per-session hard caps (spec §6.4): after 50,000 spans or 10,000 log records
 * in one app run, further items are dropped and counted. This protects a
 * runaway loop from billing the user's Azure subscription.
 */

export type CappedSignal = 'traces' | 'logs';

export const DEFAULT_SESSION_CAPS: Readonly<Record<CappedSignal, number>> = {
  traces: 50_000,
  logs: 10_000,
};

export class SessionCaps {
  private readonly used: Record<CappedSignal, number> = { traces: 0, logs: 0 };
  private readonly droppedCounts: Record<CappedSignal, number> = { traces: 0, logs: 0 };

  constructor(
    private readonly limits: Readonly<Record<CappedSignal, number>> = DEFAULT_SESSION_CAPS,
    private readonly onDrop?: (signal: CappedSignal) => void,
  ) {}

  /** Reserve one slot. Returns false (and counts a drop) once the cap is hit. */
  tryAcquire(signal: CappedSignal): boolean {
    if (this.used[signal] >= this.limits[signal]) {
      this.droppedCounts[signal]++;
      this.onDrop?.(signal);
      return false;
    }
    this.used[signal]++;
    return true;
  }

  count(signal: CappedSignal): number {
    return this.used[signal];
  }

  dropped(signal: CappedSignal): number {
    return this.droppedCounts[signal];
  }
}
