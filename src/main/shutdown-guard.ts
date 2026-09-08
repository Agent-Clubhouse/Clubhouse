export interface BeforeQuitEvent {
  preventDefault: () => void;
}

interface BeforeQuitHandlerOptions {
  killAll: () => Promise<void>;
  flushAllAgentConfigs: () => Promise<void>;
  flushAllGroupProjects?: () => Promise<void>;
  flushAllBulletinBoards?: () => Promise<void>;
  flushAllAgentQueues?: () => Promise<void>;
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
  flushAllGroupProjects,
  flushAllBulletinBoards,
  flushAllAgentQueues,
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

    const cleanups: Array<Promise<void>> = [
      killAll().catch((error) => onCleanupError('kill PTY sessions', error)),
      flushAllAgentConfigs().catch((error) => onCleanupError('flush agent configs', error)),
      flushAllGroupProjects?.().catch((error) => onCleanupError('flush group projects', error)) ?? Promise.resolve(),
      flushAllBulletinBoards?.().catch((error) => onCleanupError('flush bulletin boards', error)) ?? Promise.resolve(),
      flushAllAgentQueues?.().catch((error) => onCleanupError('flush agent queues', error)) ?? Promise.resolve(),
      applyUpdateOnQuit().catch((error) => onCleanupError('apply update on quit', error)),
    ];

    awaitShutdownCleanup(cleanups, appQuit);
  };
}
