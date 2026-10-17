export interface BeforeQuitEvent {
  preventDefault: () => void;
}

interface BeforeQuitHandlerOptions {
  /**
   * The app lifecycle shutdown (app-lifecycle.ts): blocks launches, stops every
   * runtime, drains transcripts/checkpoints/session ids and restores config.
   * Applying an update on quit waits for it.
   */
  drainRuntimes: () => Promise<void>;
  flushAllAgentConfigs: () => Promise<void>;
  flushAllGroupProjects?: () => Promise<void>;
  flushAllBulletinBoards?: () => Promise<void>;
  /**
   * Bounded by its own timeout (telemetry flushBeforeExit). Runs after every
   * other cleanup has settled, so the shutdown span it measures is exported.
   */
  flushTelemetry?: () => Promise<void>;
  /** Telemetry hooks for the shutdown span tree (spec §4.1). Never throw. */
  telemetry?: ShutdownTelemetry;
  applyUpdateOnQuit: () => Promise<void>;
  appQuit: () => void;
  onCleanupError: (operation: string, error: unknown) => void;
  beforeCleanup?: () => void;
}

export type ShutdownStepName =
  | 'runtime_drain'
  | 'agent_config_flush'
  | 'group_project_flush'
  | 'bulletin_flush'
  | 'update_apply_on_quit';

export interface ShutdownTelemetry {
  started(): void;
  step(step: ShutdownStepName, startMs: number, endMs: number, ok: boolean): void;
  completed(): void;
}

function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Telemetry hooks must never break shutdown.
  }
}

export function awaitShutdownCleanup(
  cleanups: Array<Promise<void>>,
  onComplete: () => void,
): void {
  Promise.all(cleanups).finally(onComplete);
}

export function createBeforeQuitHandler({
  drainRuntimes,
  flushAllAgentConfigs,
  flushAllGroupProjects,
  flushAllBulletinBoards,
  flushTelemetry,
  applyUpdateOnQuit,
  appQuit,
  onCleanupError,
  beforeCleanup,
  telemetry,
}: BeforeQuitHandlerOptions): (event: BeforeQuitEvent) => void {
  const timed = (step: ShutdownStepName, label: string, run: (() => Promise<void>) | undefined): Promise<void> => {
    if (!run) return Promise.resolve();
    const startMs = Date.now();
    return run().then(
      () => safely(() => telemetry?.step(step, startMs, Date.now(), true)),
      (error) => {
        safely(() => telemetry?.step(step, startMs, Date.now(), false));
        onCleanupError(label, error);
      },
    );
  };

  let isQuitting = false;

  return (event) => {
    if (isQuitting) return;
    isQuitting = true;
    safely(() => telemetry?.started());
    beforeCleanup?.();
    event.preventDefault();

    const drained = timed('runtime_drain', 'drain runtimes', drainRuntimes);
    const cleanups: Array<Promise<void>> = [
      drained,
      timed('agent_config_flush', 'flush agent configs', flushAllAgentConfigs),
      timed('group_project_flush', 'flush group projects', flushAllGroupProjects),
      timed('bulletin_flush', 'flush bulletin boards', flushAllBulletinBoards),
      // The quit-time updater replaces the app once it exits, so it must not
      // start before runtimes have stopped and config is restored.
      drained.then(() => timed('update_apply_on_quit', 'apply update on quit', applyUpdateOnQuit)),
    ];

    awaitShutdownCleanup(cleanups, () => {
      safely(() => telemetry?.completed());
      const flush = flushTelemetry?.().catch((error) => onCleanupError('flush telemetry', error)) ?? Promise.resolve();
      flush.finally(appQuit);
    });
  };
}
