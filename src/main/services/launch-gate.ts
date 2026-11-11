/**
 * Whether agents may launch. Shutdown closes it first (#2053), so a wake,
 * resume or new agent can't start a runtime while the others are being
 * stopped, or after config was restored.
 */
let closedFor: string | null = null;
let workClosed = false;
const workWaiters = new Set<() => void>();
const activeWork = new Map<string, number>();

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
  workClosed = false;
  for (const resolve of workWaiters) resolve();
  workWaiters.clear();
}

export function launchesOpen(): boolean {
  return closedFor === null;
}

export function assertLaunchesOpen(): void {
  if (closedFor !== null) throw new LaunchesClosedError(closedFor);
}

/** Remote updates freeze new messages as well as launches until shutdown ends or aborts. */
export function closeAgentWork(): void {
  workClosed = true;
}

export function agentWorkOpen(): boolean {
  return !workClosed;
}

export function assertAgentWorkOpen(): void {
  if (workClosed) throw new Error('Clubhouse is restarting; not accepting new agent work.');
}

export function whenAgentWorkOpen(): Promise<void> {
  return workClosed ? new Promise((resolve) => { workWaiters.add(resolve); }) : Promise.resolve();
}

export function hasAgentWorkInFlight(agentId: string): boolean {
  return activeWork.has(agentId);
}

export async function runAgentWork<T>(agentId: string, run: () => Promise<T>): Promise<T> {
  assertAgentWorkOpen();
  activeWork.set(agentId, (activeWork.get(agentId) ?? 0) + 1);
  try {
    return await run();
  } finally {
    const remaining = activeWork.get(agentId)! - 1;
    if (remaining) activeWork.set(agentId, remaining);
    else activeWork.delete(agentId);
  }
}
