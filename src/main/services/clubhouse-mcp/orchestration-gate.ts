/**
 * Orchestration gate (#2228): the synchronous answer to "is orchestration on
 * for this agent?" that the tool registry needs when it lists and calls
 * tools. The durable config is the source of truth; services/
 * orchestration-policy.ts writes it here when an agent spawns and whenever
 * the policy is read or changed. An agent never synced here reads as off,
 * so the gate fails closed.
 */

export type OrchestrationGateListener = (agentId: string) => void;

const enabled = new Set<string>();
const listeners = new Set<OrchestrationGateListener>();

export function isOrchestrationEnabled(agentId: string): boolean {
  return enabled.has(agentId);
}

/**
 * Record whether orchestration is on for an agent. Listeners (the tool-list
 * cache and the bridge server's tools/list_changed) fire only on a change.
 */
export function setOrchestrationEnabled(agentId: string, on: boolean): void {
  if (enabled.has(agentId) === on) return;
  if (on) enabled.add(agentId);
  else enabled.delete(agentId);
  for (const listener of listeners) {
    try {
      listener(agentId);
    } catch {
      // telemetry-exempt: one listener failing must not stop the others
    }
  }
}

/** Subscribe to changes. Returns the unsubscribe function. */
export function onOrchestrationGateChange(listener: OrchestrationGateListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For testing: forget every agent. Listeners stay subscribed. */
export function _resetOrchestrationGateForTesting(): void {
  enabled.clear();
}
