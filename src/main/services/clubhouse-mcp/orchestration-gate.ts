/**
 * Orchestration gate (#2228): the synchronous answer to "is orchestration on
 * for this agent?" that the tool registry needs when it lists and calls
 * tools. The durable config is the source of truth; services/
 * orchestration-policy.ts writes it here when an agent spawns and whenever
 * the policy is read or changed. An agent never synced here reads as off,
 * so the gate fails closed.
 *
 * Cross-project helpers (#2512) ride on the same entry: the crossProject
 * gate is open only while orchestration is open and the agent's
 * `crossProjectHelpers` policy is on, and closing orchestration closes it.
 */

export type OrchestrationGateListener = (agentId: string) => void;

import type { OrchestrationControl } from '../../../shared/orchestration-policy';

/**
 * Agents with orchestration open, whether their crossProject gate is open too,
 * and their approval setting, which the grant check reads (#2970).
 */
const enabled = new Map<string, { crossProject: boolean; control?: OrchestrationControl }>();
const listeners = new Set<OrchestrationGateListener>();

export function isOrchestrationEnabled(agentId: string): boolean {
  return enabled.has(agentId);
}

/** Whether an agent may use the cross-project tools: orchestration and cross-project helpers both on. */
export function isCrossProjectEnabled(agentId: string): boolean {
  return enabled.get(agentId)?.crossProject === true;
}

/** An orchestrating agent's approval setting; undefined when it isn't orchestrating. */
export function orchestrationControl(agentId: string): OrchestrationControl | undefined {
  return enabled.get(agentId)?.control;
}

/**
 * Record whether orchestration is on for an agent, and with `crossProject`
 * whether cross-project helpers are (only while orchestration is). Listeners
 * (the tool-list cache and the bridge server's tools/list_changed) fire only
 * on a change.
 */
export function setOrchestrationEnabled(agentId: string, on: boolean, options: { crossProject?: boolean; control?: OrchestrationControl } = {}): void {
  const crossProject = on && !!options.crossProject;
  const current = enabled.get(agentId);
  // The approval setting changes no tool list: kept without telling the listeners.
  if (on && current && options.control !== undefined) current.control = options.control;
  if (on ? current?.crossProject === crossProject : !current) return;
  if (on) enabled.set(agentId, { crossProject, ...(options.control !== undefined && { control: options.control }) });
  else enabled.delete(agentId);
  notify(agentId);
}

/** Close only the crossProject gate. Never opens anything. */
export function closeCrossProject(agentId: string): void {
  const current = enabled.get(agentId);
  if (!current?.crossProject) return;
  enabled.set(agentId, { ...current, crossProject: false });
  notify(agentId);
}

/**
 * Tell the listeners an agent's tool groups changed for another reason (the
 * Dispatcher gate, #2536), so they refresh its tool list.
 */
export function notifyToolGateChange(agentId: string): void {
  notify(agentId);
}

function notify(agentId: string): void {
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
