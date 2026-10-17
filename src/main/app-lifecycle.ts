/**
 * Application lifecycle coordinator: the one awaited boundary that quit, update
 * restart and the updater's own app.exit paths go through (#2053, audit RT-01).
 *
 * Phases run in order, each bounded by a timeout so a stuck participant can't
 * hold the app open forever:
 *   1. block new agent launches;
 *   2. capture resume state, when the caller asks (update restart);
 *   3. stop or drain every runtime (PTY, chat, headless) in parallel;
 *   4. await dependent persistence (session ids, chat transcripts, checkpoints);
 *   5. await config restoration;
 * and only then does the caller exit or apply the update.
 *
 * The coordinator knows nothing about runtime internals: each participant keeps
 * its own interrupt, permission and session semantics behind its `run`.
 */

export type ShutdownReason = 'quit' | 'update' | 'restart';

export interface LifecycleStep {
  name: string;
  run: () => Promise<void>;
}

export interface LifecycleTimeouts {
  /** Budget for resume-state capture. */
  captureMs: number;
  /** Budget per runtime participant's stop. */
  stopMs: number;
  /** Budget per drain step. */
  drainMs: number;
  /** Budget for config restoration. */
  restoreMs: number;
}

export const DEFAULT_LIFECYCLE_TIMEOUTS: LifecycleTimeouts = {
  captureMs: 10_000,
  // Past the slowest runtime's own SIGKILL fallback (PTY gracefulKill: 9s).
  stopMs: 12_000,
  drainMs: 5_000,
  restoreMs: 10_000,
};

export type LifecyclePhase = 'capture' | 'stop' | 'drain' | 'restore';

export interface AppLifecycleDeps {
  /** Phase 1: refuse new launches; `false` reopens them after an aborted update. */
  setLaunchesBlocked: (blocked: boolean) => void;
  /** Phase 3: one participant per runtime, run in parallel. */
  runtimes: LifecycleStep[];
  /** Phase 4: persistence that depends on runtimes having stopped, run in parallel. */
  drains: LifecycleStep[];
  /** Phase 5. */
  restoreConfig: () => Promise<void>;
  timeouts?: Partial<LifecycleTimeouts>;
  /** A step failed or ran out of time. Shutdown continues either way. */
  onStepError?: (phase: LifecyclePhase, name: string, error: unknown) => void;
  onPhase?: (phase: LifecyclePhase | 'blocked' | 'done', reason: ShutdownReason) => void;
}

export interface ShutdownOptions {
  reason: ShutdownReason;
  /** Phase 2. Runs before any runtime stops, so live session ids are still readable. */
  captureResumeState?: () => Promise<void>;
}

export interface AppLifecycle {
  /**
   * Run phases 1–5. Repeated calls while (or after) one runs share its promise,
   * so a second quit, or the updater's exit hook after a confirmed restart,
   * never stops runtimes twice. Never rejects.
   */
  shutdown(opts: ShutdownOptions): Promise<void>;
  /**
   * Reopen launches after a shutdown whose exit didn't happen (an update that
   * failed to apply). Stopped runtimes stay stopped; the user restarts them.
   */
  abort(): void;
  isShuttingDown(): boolean;
}

export class LifecycleTimeoutError extends Error {
  constructor(name: string, ms: number) {
    super(`${name} did not finish within ${ms}ms`);
    this.name = 'LifecycleTimeoutError';
  }
}

function bounded(name: string, ms: number, run: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LifecycleTimeoutError(name, ms)), ms);
  });
  // Start inside a promise so a synchronous throw becomes a rejection.
  const work = new Promise<void>((resolve, reject) => { run().then(resolve, reject); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export function createAppLifecycle(deps: AppLifecycleDeps): AppLifecycle {
  const timeouts = { ...DEFAULT_LIFECYCLE_TIMEOUTS, ...deps.timeouts };
  let pending: Promise<void> | undefined;

  const safe = (fn: () => void): void => {
    try { fn(); } catch { /* reporting hooks never break shutdown */ }
  };

  const step = async (phase: LifecyclePhase, name: string, ms: number, run: () => Promise<void>): Promise<void> => {
    try {
      await bounded(name, ms, run);
    } catch (error) {
      safe(() => deps.onStepError?.(phase, name, error));
    }
  };

  const all = (phase: LifecyclePhase, steps: LifecycleStep[], ms: number): Promise<unknown> =>
    Promise.all(steps.map((s) => step(phase, s.name, ms, s.run)));

  const run = async ({ reason, captureResumeState }: ShutdownOptions): Promise<void> => {
    safe(() => deps.setLaunchesBlocked(true));
    safe(() => deps.onPhase?.('blocked', reason));

    if (captureResumeState) {
      safe(() => deps.onPhase?.('capture', reason));
      await step('capture', 'resume state', timeouts.captureMs, captureResumeState);
    }

    safe(() => deps.onPhase?.('stop', reason));
    await all('stop', deps.runtimes, timeouts.stopMs);

    safe(() => deps.onPhase?.('drain', reason));
    await all('drain', deps.drains, timeouts.drainMs);

    safe(() => deps.onPhase?.('restore', reason));
    await step('restore', 'config restore', timeouts.restoreMs, deps.restoreConfig);

    safe(() => deps.onPhase?.('done', reason));
  };

  return {
    shutdown(opts) {
      pending ??= run(opts);
      return pending;
    },
    abort() {
      pending = undefined;
      safe(() => deps.setLaunchesBlocked(false));
    },
    isShuttingDown() {
      return pending !== undefined;
    },
  };
}
