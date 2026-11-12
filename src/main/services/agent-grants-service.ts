/**
 * An agent's Clubhouse permissions for the settings page (#2971, part of
 * #2921): its default grants from what it is (helper, orchestrator,
 * Dispatcher), a person's changes (agent-grants-store), and the rows to show.
 * A change reaches a running agent at its next call. Only the user's own
 * surfaces call this.
 *
 * The Dispatcher is one identity over two agents (#3036): its chat's id reads
 * and changes the Dispatcher's own grants, the ones every action runs under.
 */

import { applyGrantChanges, carriedGrants, GRANT_OFF_PERSISTENCE_FAILED, isHelperControlRow, shaped, grantKey, grantRows, isFixedGrant, normalizeGrantChanges, withGrantChange, withoutOwnChanges, withTemplateGrants, type AgentGrantsView, type GrantChange, type TemplateGrant } from '../../shared/agent-grant-changes';
import { controlFromGrantModes, controlGrantModes, defaultGrants, type GrantCallerFacts } from '../../shared/default-grants';
import { resolveOrchestrationPolicy } from '../../shared/orchestration-policy';
import { evaluateGrant, type Grant, type GrantCallTarget } from '../../shared/agent-grants';
import type { DurableAgentConfig } from '../../shared/types';
import { getDurableConfig } from './agent-config';
import { setOrchestrationPolicy } from './orchestration-policy';
import { invalidateCallApprovalsFor } from './durable-grant-approvals';
import { agentGrantChangePending, getAgentGrantChanges, updateAgentGrantChanges, withAgentGrantChange } from './agent-grants-store';
import { isDispatcherAgentId, resolveDispatcherIdentity } from './dispatcher/dispatcher-service';
import { recordGrantChange } from './grant-telemetry';
import { callerConnectedToLocalDispatcher } from './clubhouse-mcp/local-dispatcher-connections';

class GrantPolicyPersistenceError extends Error {
  readonly errors: readonly unknown[];
  constructor(revocation: unknown, policy: unknown) {
    super(GRANT_OFF_PERSISTENCE_FAILED);
    this.name = 'GrantPolicyPersistenceError';
    this.errors = [revocation, policy];
  }
}

function factsOf(agentId: string, config: DurableAgentConfig) {
  const dispatcher = isDispatcherAgentId(agentId);
  const helper = !!config.parentAgentId;
  const policy = resolveOrchestrationPolicy(config.orchestration, { helper });
  const orchestrates = !dispatcher && policy.orchestrate;
  const crossProject = orchestrates && policy.crossProjectHelpers;
  return { dispatcher, connectedToDispatcher: callerConnectedToLocalDispatcher(agentId), helper, orchestrates, crossProject, control: policy.control };
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
    throw new Error('Removing helpers asks first, which asks before starting them too. Set Delete agents and remove helpers to Allow first.');
  }
  // Through the Helpers page's own path: the agent lock, the audit record, and the refresh.
  const result = await setOrchestrationPolicy(projectPath, agentId, { control });
  if (!result.ok) throw new Error(result.message);
  // A change saved on this row before it followed the setting would win over it: drop it.
  await updateAgentGrantChanges(agentId, (saved) => {
    // Only the person's own: the template's layer stays as it is.
    const changes = saved?.changes.filter((c) => controlRow(c, { orchestrates: true, crossProject: true }) !== row) ?? [];
    return shaped(changes, saved?.template);
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
  const saved = getAgentGrantChanges(agentId);
  return {
    rows: grantRows(defaultsFor(agentId, config), saved),
    carried: carriedGrants(saved),
    helper: facts.helper,
    dispatcher: facts.dispatcher,
    orchestrates: facts.orchestrates,
  };
}

export async function readAgentGrants(projectPath: string, agentId: string): Promise<AgentGrantsView> {
  ({ projectPath, agentId } = resolveDispatcherIdentity(projectPath, agentId));
  return viewOf(agentId, await configOf(projectPath, agentId));
}

/**
 * An agent's grants from facts the caller already has (the Actions module's
 * agent cache, #2960), synchronously: its defaults and saved changes.
 */
export function grantsFromFacts(agentId: string, facts: GrantCallerFacts): Grant[] {
  if (agentGrantChangePending(agentId)) return [];
  return applyGrantChanges(defaultGrants({ ...facts, connectedToDispatcher: callerConnectedToLocalDispatcher(agentId) }), getAgentGrantChanges(agentId));
}

/** The grants an agent holds now, defaults and changes together. */
export async function effectiveAgentGrants(projectPath: string, agentId: string): Promise<Grant[]> {
  ({ projectPath, agentId } = resolveDispatcherIdentity(projectPath, agentId));
  if (agentGrantChangePending(agentId)) return [];
  const config = await configOf(projectPath, agentId);
  if (agentGrantChangePending(agentId)) return [];
  return applyGrantChanges(defaultsFor(agentId, config), getAgentGrantChanges(agentId));
}

/**
 * Set one action on one target to Off, Ask first or Allow. A change back to
 * the default is dropped. Refused for a fixed row, and for a row a wider row
 * allows, whose own setting would change nothing.
 */
export async function setAgentGrant(projectPath: string, agentId: string, change: Omit<GrantChange, 'by' | 'at'>): Promise<AgentGrantsView> {
  ({ projectPath, agentId } = resolveDispatcherIdentity(projectPath, agentId));
  const checked = normalizeGrantChanges({ changes: [{ action: change?.action, target: change?.target, mode: change?.mode }] })?.changes[0];
  if (!checked) throw new Error('Not a Clubhouse permission: an action, a target, and off, ask or allow');
  if (isFixedGrant(checked)) throw new Error('This permission is always on.');
  return withAgentGrantChange(agentId, async () => {
    const config = await configOf(projectPath, agentId);
    const facts = factsOf(agentId, config);
    let revocationError: unknown;
    try {
      await invalidateCallApprovalsFor(agentId);
    } catch (error) {
      if (checked.mode !== 'off') throw error;
      revocationError = error;
    }
    const row = controlRow(checked, facts);
    if (row) {
      await setControlRow(projectPath, agentId, row, checked.mode, facts.control);
      recordGrantChange({ agentId, layer: 'control', mode: checked.mode, action: checked.action, target: checked.target });
      return viewOf(agentId, await configOf(projectPath, agentId));
    }
    const defaults = defaultsFor(agentId, config);
    const modeBefore = grantRows(defaults, getAgentGrantChanges(agentId)).find((r) => grantKey(r) === grantKey(checked))?.mode ?? 'off';
    try {
      await updateAgentGrantChanges(agentId, (current) => {
        const row = grantRows(defaults, current).find((r) => grantKey(r) === grantKey(checked));
        if (row?.coveredBy) throw new Error('A wider permission for this allows it. Change that one instead.');
        return withGrantChange(current, { ...checked, by: 'user', at: new Date().toISOString() }, defaults);
      });
    } catch (policyError) {
      if (revocationError) throw new GrantPolicyPersistenceError(revocationError, policyError);
      throw policyError;
    }
    if (modeBefore !== checked.mode) recordGrantChange({ agentId, layer: 'own', mode: checked.mode, action: checked.action, target: checked.target });
    const savedConfig = await configOf(projectPath, agentId);
    const view = viewOf(agentId, savedConfig);
    if (!revocationError) return view;
    // Broader or overlapping grants must not be hidden behind a narrow Off row.
    const targets: GrantCallTarget[] = [];
    if (checked.target.kind === 'app') targets.push({ kind: 'app' });
    // Ownership is not known here: both possible contexts must refuse.
    else if (checked.target.kind === 'action') targets.push(
      { kind: 'action', actionId: checked.target.id },
      { kind: 'action', actionId: checked.target.id, relations: ['self'] },
    );
    const grants = applyGrantChanges(defaultsFor(agentId, savedConfig), getAgentGrantChanges(agentId));
    const effectiveOff = targets.length > 0 && targets.every((target) => evaluateGrant({
      caller: { kind: 'agent', agentId, projectPath }, action: checked.action, target,
    }, grants).outcome === 'refuse');
    return {
      ...view,
      partialFailure: {
        code: 'approval_revocation_failed', effectiveOff,
        message: effectiveOff
          ? 'Permission is Off; existing-approval revocation could not be persisted. Repair storage before enabling it.'
          : 'The restrictive setting was saved, but other matching permissions may still apply. Existing-approval revocation could not be persisted; old approvals may remain after restart. Repair storage before enabling it.',
      },
    };
  });
}

/** Reset to defaults: clears the person's changes, keeping what its template sets (#2971). */
export async function resetAgentGrants(projectPath: string, agentId: string): Promise<AgentGrantsView> {
  ({ projectPath, agentId } = resolveDispatcherIdentity(projectPath, agentId));
  return withAgentGrantChange(agentId, async () => {
    const config = await configOf(projectPath, agentId);
    await invalidateCallApprovalsFor(agentId);
    const hadOwn = (getAgentGrantChanges(agentId)?.changes.length ?? 0) > 0;
    await updateAgentGrantChanges(agentId, withoutOwnChanges);
    if (hadOwn) recordGrantChange({ agentId, layer: 'own', mode: 'reset' });
    return viewOf(agentId, config);
  });
}

/**
 * Write what a template sets (#2971): all of it when an agent is made from
 * the template, only what changed on a push (a null mode takes one away).
 * Only the user's own template edits and creation reach this; the person's
 * own changes stay over it.
 */
export async function applyTemplateGrants(agentId: string, grants: readonly TemplateGrant[]): Promise<void> {
  if (grants.length === 0) return;
  await withAgentGrantChange(agentId, async () => {
    await invalidateCallApprovalsFor(agentId);
    await updateAgentGrantChanges(agentId, (saved) => withTemplateGrants(saved, grants));
    const applied = grants.filter((g) => !isFixedGrant(g) && !isHelperControlRow(g));
    if (applied.length > 0) recordGrantChange({ agentId, layer: 'template', mode: applied.length === 1 ? applied[0].mode ?? 'reset' : 'allow', actions: applied.map((g) => g.action) });
  });
}

/** What an agent's template layer sets. */
export function templateLayerGrants(agentId: string): GrantChange[] {
  return getAgentGrantChanges(agentId)?.template ?? [];
}

/** What an agent carries over its defaults, for Save as template. */
export function carriedAgentGrants(agentId: string): GrantChange[] {
  return carriedGrants(getAgentGrantChanges(agentId));
}
