/**
 * Dispatcher gate (#2536): the synchronous answer to "is this agent the
 * running Dispatcher?" that the tool registry needs for the `dispatcher`
 * tool group. An agent is added when it spawns as the Dispatcher
 * (syncDispatcherGate) and removed when agent-registry untracks it. The gate
 * is open only while the agent is in the set and the Dispatcher is on, so it
 * fails closed.
 *
 * The Dispatcher's chat (#3036) is tracked beside it: it gets the
 * `dispatcherChat` group instead, and like the Dispatcher never the
 * orchestration groups.
 *
 * Changes go out through the orchestration gate's listeners, so the
 * tool-list cache and the bridge's tools/list_changed refresh the same way.
 */

import { isDispatcherChatPath, isDispatcherCoordinatorPath } from '../dispatcher/dispatcher-paths';
import { isDispatcherEnabled } from '../dispatcher/dispatcher-settings';
import { notifyToolGateChange } from './orchestration-gate';

const dispatcherAgents = new Set<string>();
const chatAgents = new Set<string>();
/** Bumped whenever an agent becomes or stops being the Dispatcher: other agents' tool lists depend on it too (#2968). */
let dispatcherVersion = 0;

/** Part of the tool-list cache key: which agents are the Dispatcher. */
export function dispatcherGateVersion(): number {
  return dispatcherVersion;
}

/** Whether the `dispatcher` tool group is open for an agent. */
export function isDispatcherAgent(agentId: string): boolean {
  return dispatcherAgents.has(agentId) && isDispatcherEnabled();
}

/** Whether the `dispatcherChat` tool group is open for an agent: the running chat, while the Dispatcher is on. */
export function isDispatcherChatAgent(agentId: string): boolean {
  return chatAgents.has(agentId) && isDispatcherEnabled();
}

/**
 * Whether an agent ran as either of the Dispatcher's agents, on or off. The
 * orchestration groups stay closed for it either way.
 */
export function isTrackedDispatcher(agentId: string): boolean {
  return dispatcherAgents.has(agentId) || chatAgents.has(agentId);
}

/** Whether an agent ran as the Dispatcher's chat, on or off. */
export function isTrackedDispatcherChat(agentId: string): boolean {
  return chatAgents.has(agentId);
}

/**
 * Record whether an agent is the Dispatcher. Off clears the chat too, so an
 * agent that stops is forgotten in one call. Listeners fire only on a change.
 */
export function setDispatcherAgent(agentId: string, on: boolean): void {
  const wasChat = chatAgents.delete(agentId);
  if (on === dispatcherAgents.has(agentId) && !wasChat) return;
  if (on) dispatcherAgents.add(agentId);
  else dispatcherAgents.delete(agentId);
  dispatcherVersion++;
  notifyToolGateChange(agentId);
}

/** Record whether an agent is the Dispatcher's chat. Listeners fire only on a change. */
export function setDispatcherChatAgent(agentId: string, on: boolean): void {
  if (on === chatAgents.has(agentId) && !(on && dispatcherAgents.has(agentId))) return;
  dispatcherAgents.delete(agentId);
  if (on) chatAgents.add(agentId);
  else chatAgents.delete(agentId);
  dispatcherVersion++;
  notifyToolGateChange(agentId);
}

/**
 * Set the gate for an agent that is starting (called at spawn, before the
 * MCP connects). Only the Dispatcher's own agent in its own folder gets it,
 * and only the chat's own agent in the chat's folder gets the chat's.
 */
export async function syncDispatcherGate(projectPath: string, agentId: string): Promise<void> {
  const coordinatorFolder = isDispatcherCoordinatorPath(projectPath);
  const chatFolder = isDispatcherChatPath(projectPath);
  if (!coordinatorFolder && !chatFolder) {
    setDispatcherAgent(agentId, false);
    return;
  }
  // Loaded here: dispatcher-service imports agent-system, which calls this.
  const { isDispatcherAgentId, isDispatcherChatAgentId } = await import('../dispatcher/dispatcher-service');
  if (chatFolder && isDispatcherChatAgentId(agentId)) setDispatcherChatAgent(agentId, true);
  else setDispatcherAgent(agentId, coordinatorFolder && isDispatcherAgentId(agentId));
}

/** The Dispatcher was turned on or off: its tools come and go with it. */
export function refreshDispatcherGate(): void {
  for (const agentId of [...dispatcherAgents, ...chatAgents]) notifyToolGateChange(agentId);
}

/** For testing: forget every agent. */
export function _resetDispatcherGateForTesting(): void {
  dispatcherAgents.clear();
  chatAgents.clear();
}
