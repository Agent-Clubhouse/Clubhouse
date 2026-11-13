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

import { createSettingsStore, type SettingsCommitPrecondition } from './settings-store';
import { normalizeGrantChanges, type AgentGrantChanges } from '../../shared/agent-grant-changes';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';
import { randomUUID } from 'crypto';

interface AgentGrantsFile {
  agents: Record<string, AgentGrantChanges>;
  /** Remains after reset so a removed permission cannot resurrect a queued one-time approval. */
  revisions?: Record<string, string>;
}

// Audited like other settings a person changes (#2973): which agents' permissions changed, not the targets (they can name project paths).
const store = createSettingsStore<AgentGrantsFile>('agent-grants.json', { agents: {} }, undefined, { audit: { key: 'agent_grants' } });

/** An agent's saved changes, checked: anything malformed is dropped, never widened. */
export function getAgentGrantChanges(agentId: string): AgentGrantChanges | undefined {
  const agents = store.get().agents;
  if (!agents || typeof agents !== 'object' || !Object.prototype.hasOwnProperty.call(agents, agentId)) return undefined;
  return normalizeGrantChanges(agents[agentId]);
}
export function getAgentGrantRevision(agentId: string): string { return store.get().revisions?.[agentId] ?? 'legacy'; }

/** Every agent with saved changes: for finding who holds a grant on one target (#3360). */
export function listAgentsWithGrantChanges(): string[] {
  const agents = store.get().agents;
  return agents && typeof agents === 'object' ? Object.keys(agents) : [];
}

/** Change an agent's saved changes, one write at a time; `fn` gets the current ones. Undefined clears them. */
export async function updateAgentGrantChanges(
  agentId: string,
  fn: (current: AgentGrantChanges | undefined) => AgentGrantChanges | undefined,
  precondition?: SettingsCommitPrecondition,
): Promise<AgentGrantChanges | undefined> {
  let next: AgentGrantChanges | undefined;
  await store.update((file) => {
    const agents = { ...(file.agents ?? {}) };
    const current = Object.prototype.hasOwnProperty.call(agents, agentId) ? normalizeGrantChanges(agents[agentId]) : undefined;
    next = normalizeGrantChanges(fn(current));
    if (next) agents[agentId] = next;
    else delete agents[agentId];
    return { agents, revisions: { ...file.revisions, [agentId]: randomUUID() } };
  }, precondition);
  // The next call is checked against it; the CLI lists its tools again.
  notifyToolGateChange(agentId);
  return next;
}
