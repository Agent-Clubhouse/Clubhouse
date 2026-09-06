export interface BeforeQuitEvent {
  preventDefault: () => void;
}

interface BeforeQuitHandlerOptions {
  killAll: () => Promise<void>;
  flushAllAgentConfigs: () => Promise<void>;
  applyUpdateOnQuit: () => Promise<void>;
  appQuit: () => void;
  onCleanupError: (operation: string, error: unknown) => void;
  beforeCleanup?: () => void;
}

export function awaitShutdownCleanup(
  cleanups: Array<Promise<void>>,
  onComplete: () => void,
): void {
  Promise.all(cleanups).finally(onComplete);
}

export function createBeforeQuitHandler({
  killAll,
  flushAllAgentConfigs,
  applyUpdateOnQuit,
  appQuit,
  onCleanupError,
  beforeCleanup,
}: BeforeQuitHandlerOptions): (event: BeforeQuitEvent) => void {
  let isQuitting = false;

  return (event) => {
    if (isQuitting) return;
    isQuitting = true;
    beforeCleanup?.();
    event.preventDefault();

    awaitShutdownCleanup([
      killAll().catch((error) => onCleanupError('kill PTY sessions', error)),
      flushAllAgentConfigs().catch((error) => onCleanupError('flush agent configs', error)),
      applyUpdateOnQuit().catch((error) => onCleanupError('apply update on quit', error)),
    ], appQuit);
  };
}
