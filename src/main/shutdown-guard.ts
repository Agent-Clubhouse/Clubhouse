export interface BeforeQuitEvent {
  preventDefault: () => void;
}

/** Every shutdown step, as reported in `clubhouse.shutdown.step`. */
export const SHUTDOWN_STEPS = [
  'spawn_drain',
  'pty_kill_all',
  'chat_stop',
  'headless_stop',
  'session_capture',
  'transcript_flush',
  'checkpoint_drain',
  'agent_config_flush',
  'group_project_flush',
  'bulletin_flush',
  'config_restore',
  'update_apply_on_quit',
] as const;

export type ShutdownStepName = typeof SHUTDOWN_STEPS[number];

export interface ShutdownTelemetry {
  started(): void;
  step(step: ShutdownStepName, startMs: number, endMs: number, ok: boolean): void;
  completed(): void;
}

/** One bounded piece of shutdown work. A timeout or failure is reported and shutdown goes on. */
export interface ShutdownTask {
  step: ShutdownStepName;
  /** For the error log: "Failed to <label>". */
  label: string;
  run: () => Promise<void>;
  timeoutMs: number;
}

/**
 * The phases, in order (#2053). Every task of a phase settles (or times out)
 * before the next phase starts, so exit can't overtake persistence.
 */
export interface ShutdownPlan {
  /** Synchronous: close launches, stop timers and servers. Runs first. */
  begin?: () => void;
  /** Let launches already past the gate finish, so the stop below sees their runtimes. Run together. */
  drain?: ShutdownTask[];
  /** Stop or drain every runtime (terminal, chat, headless). Run together. */
  stop: ShutdownTask[];
  /** Finish session ids, transcripts, checkpoints and config writes. Run in order. */
  persist: ShutdownTask[];
  /** Put back the config files agents changed. Run in order. */
  restore: ShutdownTask[];
}

export interface ShutdownCoordinator {
  /**
   * Run the plan once. Every caller (quit, update restart, app restart) gets
   * the same run: a repeated quit waits for it instead of starting another.
   * `after` runs last, inside the shutdown span; only the first caller's
   * counts. Never rejects.
   */
  run(after?: ShutdownTask[]): Promise<void>;
  readonly started: boolean;
  /**
   * Allow a new run after one that didn't end the app (a failed update
   * apply). Ignored while a run is in progress, so a caller still inside it
   * isn't cut loose. Returns whether it reset.
   */
  reset(): boolean;
}

export interface ShutdownCoordinatorOptions {
  plan: () => ShutdownPlan;
  telemetry?: ShutdownTelemetry;
  onCleanupError: (operation: string, error: unknown) => void;
  /**
   * Cap on the whole run. Each step gets the lesser of its own timeout and
   * what's left; a step with nothing left is skipped and reported.
   */
  deadlineMs?: number;
  /**
   * Kept back from the steps before restore, so the config restore always
   * gets at least this long, even after the deadline.
   */
  restoreReserveMs?: number;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telemetry hooks must never break shutdown.
  }
}

export class ShutdownTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not finish within ${timeoutMs}ms`);
    this.name = 'ShutdownTimeoutError';
  }
}

export class ShutdownDeadlineError extends Error {
  constructor(label: string, deadlineMs: number) {
    super(`${label} skipped: the ${deadlineMs}ms shutdown deadline was reached`);
    this.name = 'ShutdownDeadlineError';
  }
}

/** Run a task, bounded by `budgetMs`. Resolves either way; failures and timeouts go to onError. */
async function runTask(
  task: ShutdownTask,
  budgetMs: number,
  telemetry: ShutdownTelemetry | undefined,
  onError: (operation: string, error: unknown) => void,
): Promise<void> {
  const startMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShutdownTimeoutError(task.label, budgetMs)), budgetMs);
  });
  try {
    await Promise.race([Promise.resolve().then(task.run), timeout]);
    safely(() => telemetry?.step(task.step, startMs, Date.now(), true));
  } catch (error) {
    safely(() => telemetry?.step(task.step, startMs, Date.now(), false));
    onError(task.label, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createShutdownCoordinator({
  plan,
  telemetry,
  onCleanupError,
  deadlineMs = Number.POSITIVE_INFINITY,
  restoreReserveMs = 0,
}: ShutdownCoordinatorOptions): ShutdownCoordinator {
  let running: Promise<void> | undefined;
  let inProgress = false;

  const execute = async (after: ShutdownTask[]): Promise<void> => {
    inProgress = true;
    const deadlineAt = Date.now() + deadlineMs;
    /** `floorMs`: the least the step gets, even past the deadline (the restore's reserve). */
    const bounded = async (task: ShutdownTask, reserveMs: number, floorMs = 0): Promise<void> => {
      const left = Math.max(deadlineAt - reserveMs - Date.now(), floorMs);
      if (left <= 0) {
        safely(() => telemetry?.step(task.step, Date.now(), Date.now(), false));
        onCleanupError(task.label, new ShutdownDeadlineError(task.label, deadlineMs));
        return;
      }
      await runTask(task, Math.min(task.timeoutMs, left), telemetry, onCleanupError);
    };
    try {
      safely(() => telemetry?.started());
      const { begin, drain = [], stop, persist, restore } = plan();
      try {
        begin?.();
      } catch (error) {
        onCleanupError('begin shutdown', error);
      }
      await Promise.all(drain.map((task) => bounded(task, restoreReserveMs)));
      await Promise.all(stop.map((task) => bounded(task, restoreReserveMs)));
      for (const task of persist) await bounded(task, restoreReserveMs);
      for (const task of restore) await bounded(task, 0, restoreReserveMs);
      for (const task of after) await bounded(task, 0);
      safely(() => telemetry?.completed());
    } finally {
      inProgress = false;
    }
  };

  return {
    run: (after = []) => (running ??= execute(after)),
    get started() {
      return running !== undefined;
    },
    reset: () => {
      if (inProgress) return false;
      running = undefined;
      return true;
    },
  };
}

/** The installer can take a while to start (the Windows Update.exe spawn). */
const APPLY_UPDATE_ON_QUIT_TIMEOUT_MS = 30_000;

interface BeforeQuitHandlerOptions {
  /** Stop runtimes, persist and restore config: the shared coordinator's run, with `after` last. */
  shutdown: (after: ShutdownTask[]) => Promise<void>;
  /**
   * Bounded by its own timeout (telemetry flushBeforeExit). Runs after every
   * other cleanup has settled, so the shutdown span it measures is exported.
   */
  flushTelemetry?: () => Promise<void>;
  /** Hands an update to the installer. Runs after shutdown, so it never replaces files under a running agent. */
  applyUpdateOnQuit: () => Promise<void>;
  appQuit: () => void;
  onCleanupError: (operation: string, error: unknown) => void;
}

export function createBeforeQuitHandler({
  shutdown,
  flushTelemetry,
  applyUpdateOnQuit,
  appQuit,
  onCleanupError,
}: BeforeQuitHandlerOptions): (event: BeforeQuitEvent) => void {
  let isQuitting = false;

  return (event) => {
    // The second before-quit is our own appQuit(): let it through.
    if (isQuitting) return;
    isQuitting = true;
    event.preventDefault();

    const applyUpdate: ShutdownTask = {
      step: 'update_apply_on_quit',
      label: 'apply update on quit',
      run: applyUpdateOnQuit,
      timeoutMs: APPLY_UPDATE_ON_QUIT_TIMEOUT_MS,
    };
    void (async () => {
      await shutdown([applyUpdate]).catch((error) => onCleanupError('shut down', error));
      await (flushTelemetry?.() ?? Promise.resolve()).catch((error) => onCleanupError('flush telemetry', error));
      appQuit();
    })();
  };
}
