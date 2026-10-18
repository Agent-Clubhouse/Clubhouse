export interface BeforeQuitEvent {
  preventDefault: () => void;
}

export type ShutdownStepName =
  | 'pty_kill_all'
  | 'chat_stop'
  | 'headless_stop'
  | 'session_capture'
  | 'transcript_flush'
  | 'checkpoint_drain'
  | 'agent_config_flush'
  | 'group_project_flush'
  | 'bulletin_flush'
  | 'config_restore'
  | 'update_apply_on_quit';

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
  /** Allow a new run after one that didn't end the app (a failed update apply). */
  reset(): void;
}

export interface ShutdownCoordinatorOptions {
  plan: () => ShutdownPlan;
  telemetry?: ShutdownTelemetry;
  onCleanupError: (operation: string, error: unknown) => void;
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

/** Run a task, bounded by its timeout. Resolves either way; failures and timeouts go to onError. */
async function runTask(
  task: ShutdownTask,
  telemetry: ShutdownTelemetry | undefined,
  onError: (operation: string, error: unknown) => void,
): Promise<void> {
  const startMs = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ShutdownTimeoutError(task.label, task.timeoutMs)), task.timeoutMs);
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

export function createShutdownCoordinator({ plan, telemetry, onCleanupError }: ShutdownCoordinatorOptions): ShutdownCoordinator {
  let running: Promise<void> | undefined;

  const execute = async (after: ShutdownTask[]): Promise<void> => {
    safely(() => telemetry?.started());
    const { begin, stop, persist, restore } = plan();
    try {
      begin?.();
    } catch (error) {
      onCleanupError('begin shutdown', error);
    }
    await Promise.all(stop.map((task) => runTask(task, telemetry, onCleanupError)));
    for (const task of persist) await runTask(task, telemetry, onCleanupError);
    for (const task of restore) await runTask(task, telemetry, onCleanupError);
    for (const task of after) await runTask(task, telemetry, onCleanupError);
    safely(() => telemetry?.completed());
  };

  return {
    run: (after = []) => (running ??= execute(after)),
    get started() {
      return running !== undefined;
    },
    reset: () => {
      running = undefined;
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
