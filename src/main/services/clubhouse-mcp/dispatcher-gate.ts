/**
 * Dispatcher gate (#2536): the synchronous answer to "is this agent the
 * running Dispatcher?" that the tool registry needs for the `dispatcher`
 * tool group. An agent is added when it spawns as the Dispatcher
 * (syncDispatcherGate) and removed when agent-registry untracks it. The gate
 * is open only while the agent is in the set and the Dispatcher is on, so it
 * fails closed.
 *
 * Changes go out through the orchestration gate's listeners, so the
 * tool-list cache and the bridge's tools/list_changed refresh the same way.
 */

import { isDispatcherPath } from '../dispatcher/dispatcher-paths';
import { isDispatcherEnabled } from '../dispatcher/dispatcher-settings';
import { notifyToolGateChange } from './orchestration-gate';

const dispatcherAgents = new Set<string>();

/** Whether the `dispatcher` tool group is open for an agent. */
export function isDispatcherAgent(agentId: string): boolean {
  return dispatcherAgents.has(agentId) && isDispatcherEnabled();
}

/**
 * Whether an agent ran as the Dispatcher, on or off. The orchestration
 * groups stay closed for it either way.
 */
export function isTrackedDispatcher(agentId: string): boolean {
  return dispatcherAgents.has(agentId);
}

/** Record whether an agent is the Dispatcher. Listeners fire only on a change. */
export function setDispatcherAgent(agentId: string, on: boolean): void {
  if (on === dispatcherAgents.has(agentId)) return;
  if (on) dispatcherAgents.add(agentId);
  else dispatcherAgents.delete(agentId);
  notifyToolGateChange(agentId);
}

/**
 * Set the gate for an agent that is starting (called at spawn, before the
 * MCP connects). Only the Dispatcher's own agent in its own folder gets it.
 */
export async function syncDispatcherGate(projectPath: string, agentId: string): Promise<void> {
  if (!isDispatcherPath(projectPath)) {
    setDispatcherAgent(agentId, false);
    return;
  }
  // Loaded here: dispatcher-service imports agent-system, which calls this.
  const { isDispatcherAgentId } = await import('../dispatcher/dispatcher-service');
  setDispatcherAgent(agentId, isDispatcherAgentId(agentId));
}

/** The Dispatcher was turned on or off: its tools come and go with it. */
export function refreshDispatcherGate(): void {
  for (const agentId of dispatcherAgents) notifyToolGateChange(agentId);
}

/** For testing: forget every agent. */
export function _resetDispatcherGateForTesting(): void {
  dispatcherAgents.clear();
}
