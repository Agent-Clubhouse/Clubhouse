/**
 * Whether agents may launch. Shutdown closes it first (#2053), so a wake,
 * resume or new agent can't start a runtime while the others are being
 * stopped, or after config was restored.
 */
let closedFor: string | null = null;

export class LaunchesClosedError extends Error {
  constructor(reason: string) {
    super(`Clubhouse is ${reason}; not starting new agents`);
    this.name = 'LaunchesClosedError';
  }
}

export function closeLaunches(reason: string): void {
  closedFor = reason;
}

/** Reopen after a shutdown that didn't end the app (a failed update apply, the dev restart). */
export function reopenLaunches(): void {
  closedFor = null;
}

export function launchesOpen(): boolean {
  return closedFor === null;
}

export function assertLaunchesOpen(): void {
  if (closedFor !== null) throw new LaunchesClosedError(closedFor);
}
