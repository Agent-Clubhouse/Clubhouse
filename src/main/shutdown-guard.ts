export function awaitShutdownCleanup(
  cleanups: Array<Promise<void>>,
  onComplete: () => void,
): void {
  Promise.all(cleanups).finally(onComplete);
}
