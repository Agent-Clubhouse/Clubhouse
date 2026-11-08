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
import { getDurableConfig, setOrchestrationConfig } from './agent-config';
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
function controlRow(change: Pick<GrantChange, 'action' | 'target'>): 'create' | 'dispose' | null {
  if (change.action === 'agent.create' && change.target.kind === 'project' && (change.target.project === 'own' || change.target.project === 'any')) return 'create';
  if (change.action === 'agent.dispose' && change.target.kind === 'my_helpers') return 'dispose';
  return null;
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
  const row = controlRow(checked);
  if (row && facts.orchestrates) {
    if (checked.mode === 'off') throw new Error('To stop it starting or disposing helpers, turn off Let this agent orchestrate.');
    const modes = { ...controlGrantModes(facts.control), [row]: checked.mode };
    await setOrchestrationConfig(projectPath, agentId, { ...config.orchestration, control: controlFromGrantModes(modes) });
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
  await updateAgentGrantChanges(agentId, () => undefined);
  return viewOf(agentId, config);
}
