/**
 * Where a person's changes to agents' Clubhouse permissions live (#2971):
 * `agent-grants.json` in the app's data folder, keyed by agent id. Not in the
 * project's `.clubhouse/agents.json`, which an agent's CLI can often write: a
 * grant an agent wrote there for itself would get around "no raising
 * yourself". The grant check reads this store on every call, and a change
 * tells the agent's CLI to list its tools again.
 *
 * Grants are still a guardrail, not a sandbox: a process running as the user
 * can edit this file too, though it is read only at app start.
 */

import { createSettingsStore } from './settings-store';
import { normalizeGrantChanges, type AgentGrantChanges } from '../../shared/agent-grant-changes';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';

interface AgentGrantsFile {
  agents: Record<string, AgentGrantChanges>;
}

// Audited like other settings a person changes (#2973): which agents' permissions changed, not the targets (they can name project paths).
const store = createSettingsStore<AgentGrantsFile>('agent-grants.json', { agents: {} }, undefined, {
  audit: { key: 'agent_grants' }, atomic: true, mode: 0o600, rollBackFailedSaves: true,
});
let committed: AgentGrantsFile | undefined;
const currentFile = (): AgentGrantsFile => committed ??= structuredClone(store.get());
const pending = new Map<string, number>();

export function agentGrantChangePending(agentId: string): boolean {
  return (pending.get(agentId) ?? 0) > 0;
}

export async function withAgentGrantChange<T>(agentId: string, change: () => Promise<T>): Promise<T> {
  const before = pending.get(agentId) ?? 0;
  pending.set(agentId, before + 1);
  try {
    if (before === 0) notifyToolGateChange(agentId);
    return await change();
  } finally {
    const remaining = (pending.get(agentId) ?? 1) - 1;
    if (remaining > 0) pending.set(agentId, remaining);
    else {
      pending.delete(agentId);
      notifyToolGateChange(agentId);
    }
  }
}

/** An agent's saved changes, checked: anything malformed is dropped, never widened. */
export function getAgentGrantChanges(agentId: string): AgentGrantChanges | undefined {
  const agents = currentFile().agents;
  if (!agents || typeof agents !== 'object' || !Object.prototype.hasOwnProperty.call(agents, agentId)) return undefined;
  return normalizeGrantChanges(agents[agentId]);
}

/** Change an agent's saved changes, one write at a time; `fn` gets the current ones. Undefined clears them. */
export async function updateAgentGrantChanges(
  agentId: string,
  fn: (current: AgentGrantChanges | undefined) => AgentGrantChanges | undefined,
): Promise<AgentGrantChanges | undefined> {
  return withAgentGrantChange(agentId, async () => {
    let next: AgentGrantChanges | undefined;
    currentFile();
    const saved = await store.update((file) => {
      const agents = { ...(file.agents ?? {}) };
      const current = Object.prototype.hasOwnProperty.call(agents, agentId) ? normalizeGrantChanges(agents[agentId]) : undefined;
      next = normalizeGrantChanges(fn(current));
      if (next) agents[agentId] = next;
      else delete agents[agentId];
      return { agents };
    });
    committed = structuredClone(saved);
    return next;
  });
}
