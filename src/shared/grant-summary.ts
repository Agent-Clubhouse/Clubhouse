import { GRANT_ACTION_LABELS, grantTargetLabel, targetKey } from './agent-grant-changes';
import type { Grant } from './agent-grants';
import { defaultGrants, type GrantCallerFacts } from './default-grants';
import type { OrchestrationPolicyConfig } from './orchestration-policy';

/**
 * What an agent made from a template can do through Clubhouse (#2971, part of
 * #2921), for New agent: one plain line, and the full list by target. Built
 * from the same default grants the call-time check uses, so it can't drift
 * from what agents actually get.
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
export function grantSummaryLine(facts: GrantCallerFacts): string {
  const base = 'Through Clubhouse it can read and message agents it\'s connected to';
  if (!facts.orchestrates) return `${base}.`;
  const where = facts.crossProject ? ' in any project' : '';
  const asks = facts.control === 'ask-everything' ? ', asking you before starting or removing one'
    : facts.control === 'ask-before-start' ? ', asking you before starting one'
      : '';
  return `${base}, and start and manage its own helpers${where}${asks}.`;
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

/** Both, for a template's orchestration settings. */
export function templateGrantSummary(orchestration: OrchestrationPolicyConfig | undefined): { line: string; groups: GrantSummaryGroup[] } {
  const facts = templateGrantFacts(orchestration);
  return { line: grantSummaryLine(facts), groups: grantSummaryGroups(defaultGrants(facts)) };
}
