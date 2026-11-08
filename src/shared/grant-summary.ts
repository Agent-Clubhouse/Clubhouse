import { GRANT_ACTION_LABELS, grantTargetLabel, targetKey, templateBase, type TemplateGrant } from './agent-grant-changes';
import type { Grant, GrantAction } from './agent-grants';
import { defaultGrants, type GrantCallerFacts } from './default-grants';
import type { OrchestrationPolicyConfig } from './orchestration-policy';

/**
 * What an agent made from a template can do through Clubhouse (#2971, part of
 * #2921), for New agent: one plain line, and the full list by target. Built
 * from the same default grants the call-time check uses, with the template's
 * own permissions over them, as agents made from it get them.
 */

/** The facts a template decides: a new agent is never the Dispatcher or a helper. */
export function templateGrantFacts(orchestration: OrchestrationPolicyConfig | undefined): GrantCallerFacts {
  const orchestrates = !!orchestration?.orchestrate;
  return {
    dispatcher: false,
    helper: false,
    orchestrates,
    crossProject: orchestrates && !!orchestration?.crossProjectHelpers,
    control: orchestration?.control ?? 'hands-off',
  };
}

/** The one line: what stands out, in plain words. */
export function grantSummaryLine(facts: GrantCallerFacts, grants: readonly Grant[] = defaultGrants(facts)): string {
  const holds = (action: GrantAction, kind: Grant['target']['kind']) => grants.some((g) => g.action === action && g.target.kind === kind);
  const read = holds('agent.read', 'connected');
  const message = holds('agent.message', 'connected');
  const reach = read && message ? 'read and message agents it\'s connected to'
    : read ? 'read agents it\'s connected to'
      : message ? 'message agents it\'s connected to'
        : null;
  if (!facts.orchestrates) return reach ? `Through Clubhouse it can ${reach}.` : 'Through Clubhouse it can\'t read or message the agents it\'s connected to.';
  const where = facts.crossProject ? ' in any project' : '';
  const asks = facts.control === 'ask-everything' ? ', asking you before starting or removing one'
    : facts.control === 'ask-before-start' ? ', asking you before starting one'
      : '';
  const helpers = `start and manage its own helpers${where}${asks}`;
  return reach ? `Through Clubhouse it can ${reach}, and ${helpers}.` : `Through Clubhouse it can ${helpers}.`;
}

export interface GrantSummaryGroup {
  /** The target, in the page's words ("Its helpers", "The app"). */
  label: string;
  /** Each action's label, with "(asks first)" for Ask first. */
  actions: string[];
}

/** Every grant by target, in the order the defaults list them. */
export function grantSummaryGroups(grants: readonly Grant[]): GrantSummaryGroup[] {
  const groups = new Map<string, GrantSummaryGroup>();
  for (const g of grants) {
    const key = targetKey(g.target);
    let group = groups.get(key);
    if (!group) {
      group = { label: grantTargetLabel(g.target), actions: [] };
      groups.set(key, group);
    }
    const label = `${GRANT_ACTION_LABELS[g.action] ?? g.action}${g.mode === 'ask' ? ' (asks first)' : ''}`;
    if (!group.actions.includes(label)) group.actions.push(label);
  }
  return [...groups.values()];
}

/** Both, for a template's orchestration settings and its own permissions. */
export function templateGrantSummary(orchestration: OrchestrationPolicyConfig | undefined, templateGrants: readonly TemplateGrant[] = []): { line: string; groups: GrantSummaryGroup[] } {
  const facts = templateGrantFacts(orchestration);
  const layer = templateGrants.flatMap((g) => (g.mode === null ? [] : [{ action: g.action, target: g.target, mode: g.mode }]));
  const grants = templateBase(defaultGrants(facts), { changes: [], template: layer });
  return { line: grantSummaryLine(facts, grants), groups: grantSummaryGroups(grants) };
}
