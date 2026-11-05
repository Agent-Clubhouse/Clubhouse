/** A short exclusive reservation for a guided lifecycle/config transition.
 * Existing starts and writes register before their first await. Competing
 * callers fail visibly rather than being queued into a later, surprising action.
 * Exit bookkeeping is deliberately outside this gate: stopping awaits it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const owner = new AsyncLocalStorage<symbol>();
const reservations = new Map<string, symbol>();
const activities = new Map<string, number>();
const generations = new Map<string, number>();
export class AgentTransitionError extends Error {
  readonly code = 'agent_transition_busy';
  constructor() { super('The agent is changing state. Refresh before trying again.'); }
}
export const agentTransitionGeneration = (id: string): number => generations.get(id) ?? 0;
export const agentTransitionBusy = (id: string): boolean => !!activities.get(id) || reservations.has(id);

export async function withAgentActivity<T>(id: string, run: () => Promise<T>): Promise<T> {
  const lease = reservations.get(id);
  if (lease && lease !== owner.getStore()) throw new AgentTransitionError();
  activities.set(id, (activities.get(id) ?? 0) + 1);
  generations.set(id, agentTransitionGeneration(id) + 1);
  try { return await run(); }
  finally {
    const count = (activities.get(id) ?? 1) - 1;
    if (count) activities.set(id, count); else activities.delete(id);
  }
}

export async function withAgentTransition<T>(id: string, run: () => Promise<T>): Promise<T> {
  if (agentTransitionBusy(id)) throw new AgentTransitionError();
  const lease = Symbol(id);
  reservations.set(id, lease);
  try { return await owner.run(lease, run); }
  finally { reservations.delete(id); }
}

// Reject a wake prepared with the old provider before a completed switch.
const selectedProviders = new Map<string, string>();
export function noteProviderSelection(id: string, provider: string): void { selectedProviders.set(id, provider); }
export function assertProviderSelection(id: string, provider: string | undefined): void {
  if (provider && selectedProviders.has(id) && selectedProviders.get(id) !== provider) throw new AgentTransitionError();
}

export class AgentResumeError extends Error {
  constructor(readonly code: 'resume_unverified' | 'resume_failed') { super(code); }
}
