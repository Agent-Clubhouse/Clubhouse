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
import { readDisplaySettings, ownDisplayValue, displayInput, agentDisplayInput, type DisplayValue } from './display-settings';
import { normalizeGrantChanges, type AgentGrantChanges } from '../../shared/agent-grant-changes';
import { notifyToolGateChange } from './clubhouse-mcp/orchestration-gate';
import { randomUUID } from 'crypto';

interface AgentGrantsFile {
  agents: Record<string, AgentGrantChanges>;
  /** Remains after reset so a removed permission cannot resurrect a queued one-time approval. */
  revisions?: Record<string, string>;
}

// Audited like other settings a person changes (#2973): which agents' permissions changed, not the targets (they can name project paths).
const store = createSettingsStore<AgentGrantsFile>('agent-grants.json', { agents: {} }, undefined, { displaySnapshot: true, audit: { key: 'agent_grants' } });

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

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const DISPLAY_GRANT_LAYER_LIMIT = 100;

/** Internal selected-record evidence. Never serialize this store or its raw change records. */
export function readAgentGrantChangesForDisplay(agentId: string): DisplayValue<AgentGrantChanges | undefined> {
  if (!agentId || agentId.length > 2048) return { state: 'unavailable', reason: 'invalid', inputs: [agentDisplayInput('Selected agent permissions')] };
  const evidence = readDisplaySettings(store, 'agent-grants.json'), inputs = [displayInput('Saved agent permissions', evidence)];
  const unknown = (reason: 'unreadable' | 'invalid' | 'limit' = 'invalid'): DisplayValue<AgentGrantChanges | undefined> => ({ state: 'unavailable', inputs, reason });
  if (evidence.state !== 'ok') return unknown('unreadable');
  const agents = ownDisplayValue(evidence.raw, 'agents');
  if (agents !== undefined && !record(agents)) return unknown();
  const selected = agents === undefined ? undefined : ownDisplayValue(agents as Record<string, unknown>, agentId);
  if (selected === undefined) return { state: 'ok', value: undefined, inputs };
  if (!record(selected) || !['changes', 'template'].some((key) => ownDisplayValue(selected, key) !== undefined)) return unknown();
  for (const layer of ['changes', 'template'] as const) {
    const list = ownDisplayValue(selected, layer);
    if (list === undefined) continue;
    if (!Array.isArray(list)) return unknown();
    if (list.length > DISPLAY_GRANT_LAYER_LIMIT) return unknown('limit');
    for (const entry of list) {
      if (!record(entry) || !record(entry.target)) return unknown();
      const target = entry.target;
      if (target.kind === 'connected' && (['onlyDispatcher', 'excludeDispatcher', 'wakeOn'].some((key) => target[key] !== undefined && typeof target[key] !== 'boolean')
        || ['onlyDispatcher', 'excludeDispatcher', 'wakeOn'].filter((key) => target[key] === true).length > 1)) return unknown();
      // Reuse the execution parser for action/target/mode classification, but do
      // not silently discard malformed entries into verified empty/defaults.
      const rebuilt = normalizeGrantChanges({ [layer]: [entry] })?.[layer];
      if (rebuilt?.length !== 1) return unknown();
      if (Buffer.byteLength(JSON.stringify(rebuilt[0])) > 4096) return unknown('limit');
    }
  }
  return { state: 'ok', value: normalizeGrantChanges(selected), inputs };
}
