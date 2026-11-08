/**
 * An agent's Clubhouse permissions for the settings page (#2971, part of
 * #2921): its default grants from what it is (helper, orchestrator,
 * Dispatcher), a person's changes (agent-grants-store), and the rows to show.
 * A change reaches a running agent at its next call. Only the user's own
 * surfaces call this.
 */

import { applyGrantChanges, grantKey, grantRows, isFixedGrant, normalizeGrantChanges, withGrantChange, type AgentGrantsView, type GrantChange } from '../../shared/agent-grant-changes';
import { controlFromGrantModes, controlGrantModes, defaultGrants } from '../../shared/default-grants';
import { resolveOrchestrationPolicy } from '../../shared/orchestration-policy';
import type { Grant } from '../../shared/agent-grants';
import type { DurableAgentConfig } from '../../shared/types';
import { getDurableConfig } from './agent-config';
import { setOrchestrationPolicy } from './orchestration-policy';
import { dropCallApprovalsFor } from './grant-requests';
import { getAgentGrantChanges, updateAgentGrantChanges } from './agent-grants-store';
import { isDispatcherAgentId } from './dispatcher/dispatcher-service';

function factsOf(agentId: string, config: DurableAgentConfig) {
  const dispatcher = isDispatcherAgentId(agentId);
  const helper = !!config.parentAgentId;
  const policy = resolveOrchestrationPolicy(config.orchestration, { helper });
  const orchestrates = !dispatcher && policy.orchestrate;
  const crossProject = orchestrates && policy.crossProjectHelpers;
  return { dispatcher, helper, orchestrates, crossProject, control: policy.control };
}

/**
 * Starting and disposing helpers belong to the orchestrator's approval setting
 * (#2970): a change to either on this page changes that setting, so the
 * Helpers card, the tools and this page always agree. Which one, or null for
 * any other row.
 */
export function controlRow(change: Pick<GrantChange, 'action' | 'target'>, facts: { orchestrates: boolean; crossProject: boolean }): 'create' | 'dispose' | null {
  if (!facts.orchestrates) return null;
  if (change.action === 'agent.create' && change.target.kind === 'project') {
    // Starting helpers anywhere is a row only with cross-project helpers on.
    if (change.target.project === 'own' || (change.target.project === 'any' && facts.crossProject)) return 'create';
  }
  if (change.action === 'agent.dispose' && change.target.kind === 'my_helpers') return 'dispose';
  return null;
}

/** Set the approval setting from one of its rows. Refuses a pair of modes that has no setting. */
async function setControlRow(projectPath: string, agentId: string, row: 'create' | 'dispose', mode: GrantChange['mode'], current: ReturnType<typeof factsOf>['control']): Promise<void> {
  if (mode === 'off') throw new Error('To stop it starting or removing helpers, turn off Let this agent orchestrate.');
  const modes = { ...controlGrantModes(current), [row]: mode };
  const control = controlFromGrantModes(modes);
  if (controlGrantModes(control)[row] !== mode) {
    // Asking before removing helpers always asks before starting them too.
    throw new Error('Removing helpers asks first, which asks before starting them too. Set Remove helpers to Allow first.');
  }
  // Through the Helpers page's own path: the agent lock, the audit record, and the refresh.
  const result = await setOrchestrationPolicy(projectPath, agentId, { control });
  if (!result.ok) throw new Error(result.message);
  // A change saved on this row before it followed the setting would win over it: drop it.
  await updateAgentGrantChanges(agentId, (saved) => {
    const changes = saved?.changes.filter((c) => controlRow(c, { orchestrates: true, crossProject: true }) !== row) ?? [];
    return changes.length > 0 ? { ...saved, changes } : undefined;
  });
}

function defaultsFor(agentId: string, config: DurableAgentConfig): Grant[] {
  return defaultGrants(factsOf(agentId, config));
}

async function configOf(projectPath: string, agentId: string): Promise<DurableAgentConfig> {
  const config = await getDurableConfig(projectPath, agentId);
  if (!config) throw new Error('Agent not found');
  return config;
}

function viewOf(agentId: string, config: DurableAgentConfig): AgentGrantsView {
  const facts = factsOf(agentId, config);
  return {
    rows: grantRows(defaultsFor(agentId, config), getAgentGrantChanges(agentId)),
    helper: facts.helper,
    dispatcher: facts.dispatcher,
    orchestrates: facts.orchestrates,
  };
}

export async function readAgentGrants(projectPath: string, agentId: string): Promise<AgentGrantsView> {
  return viewOf(agentId, await configOf(projectPath, agentId));
}

/** The grants an agent holds now, defaults and changes together. */
export async function effectiveAgentGrants(projectPath: string, agentId: string): Promise<Grant[]> {
  const config = await configOf(projectPath, agentId);
  return applyGrantChanges(defaultsFor(agentId, config), getAgentGrantChanges(agentId));
}

/**
 * Set one action on one target to Off, Ask first or Allow. A change back to
 * the default is dropped. Refused for a fixed row, and for a row a wider row
 * allows, whose own setting would change nothing.
 */
export async function setAgentGrant(projectPath: string, agentId: string, change: Omit<GrantChange, 'by' | 'at'>): Promise<AgentGrantsView> {
  const checked = normalizeGrantChanges({ changes: [{ action: change?.action, target: change?.target, mode: change?.mode }] })?.changes[0];
  if (!checked) throw new Error('Not a Clubhouse permission: an action, a target, and off, ask or allow');
  if (isFixedGrant(checked)) throw new Error('This permission is always on.');
  const config = await configOf(projectPath, agentId);
  const facts = factsOf(agentId, config);
  // A one-time approval was given under the old setting: it doesn't outlive a change (#2970).
  dropCallApprovalsFor(agentId);
  const row = controlRow(checked, facts);
  if (row) {
    await setControlRow(projectPath, agentId, row, checked.mode, facts.control);
    return viewOf(agentId, await configOf(projectPath, agentId));
  }
  const defaults = defaultsFor(agentId, config);
  await updateAgentGrantChanges(agentId, (current) => {
    const row = grantRows(defaults, current).find((r) => grantKey(r) === grantKey(checked));
    if (row?.coveredBy) throw new Error('A wider permission for this allows it. Change that one instead.');
    return withGrantChange(current, { ...checked, by: 'user', at: new Date().toISOString() }, defaults);
  });
  return viewOf(agentId, config);
}

/** Reset to defaults: clears every change. */
export async function resetAgentGrants(projectPath: string, agentId: string): Promise<AgentGrantsView> {
  const config = await configOf(projectPath, agentId);
  dropCallApprovalsFor(agentId);
  await updateAgentGrantChanges(agentId, () => undefined);
  return viewOf(agentId, config);
}
