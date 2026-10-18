/**
 * Session-id writes started by a run ending, per agent: a terminal run's exit
 * capture, or a chat session's native id. A restart that resumes waits for
 * the agent's write (#2027), and quit and update wait for all of them before
 * the final config flush (#2053), or the next launch resumes a stale id.
 */
const pending = new Map<string, Promise<void>>();

/** Track a session-id write for the agent. Writes for the same agent chain, so waiting covers each one. */
export function trackSessionCapture(agentId: string, write: Promise<void>): void {
  const previous = pending.get(agentId);
  const settled = (previous ? Promise.allSettled([previous, write]) : Promise.allSettled([write])).then((): void => undefined);
  pending.set(agentId, settled);
  void settled.then(() => {
    if (pending.get(agentId) === settled) pending.delete(agentId);
  });
}

/** The agent's session-id write in progress, if any. Never rejects. */
export function sessionCaptureFor(agentId: string): Promise<void> | undefined {
  return pending.get(agentId);
}

/** Resolves once every session-id write, including ones started meanwhile, has settled. */
export async function whenSessionCapturesSettled(): Promise<void> {
  while (pending.size) await Promise.all([...pending.values()]);
}

/** For tests. */
export function clearSessionCaptures(): void {
  pending.clear();
}
