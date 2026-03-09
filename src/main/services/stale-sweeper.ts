/** Interval (ms) between stale session sweep checks. */
const DEFAULT_SWEEP_INTERVAL = 30_000;

export interface StaleSweepCallbacks<T> {
  /** Return true if the session's process has died without cleanup. */
  isStale: (agentId: string, session: T) => boolean;
  /** Handle cleanup and notifications for a stale session. */
  onStale: (agentId: string, session: T) => void;
}

/**
 * Generic periodic sweeper that detects stale sessions whose processes have
 * died without triggering normal exit/close handlers (a safety net).
 *
 * Parameterized by a liveness check and a cleanup callback so the same
 * start/stop/interval logic is shared across PTY and headless managers.
 */
export class StaleSweeper<T> {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sessions: Map<string, T>,
    private callbacks: StaleSweepCallbacks<T>,
    private intervalMs: number = DEFAULT_SWEEP_INTERVAL,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [agentId, session] of this.sessions) {
        if (this.callbacks.isStale(agentId, session)) {
          this.callbacks.onStale(agentId, session);
        }
      }
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
