import type { Action, ActionOwner, ActionRun } from './types';

export interface ActionOwnerUsage {
  /** Older history for a deleted action may have no recorded owner. */
  owner?: ActionOwner;
  actions: Array<{ id: string; name: string }>;
  runs24h: number;
  runs7d: number;
  failures24h: number;
  failures7d: number;
}

/** Counts retained history, not lifetime usage. No additional persistence. */
export function summarizeActionUsage(actions: Action[], runs: ActionRun[], now = Date.now()): ActionOwnerUsage[] {
  const groups = new Map<string, ActionOwnerUsage>();
  const groupFor = (owner?: ActionOwner): ActionOwnerUsage => {
    const key = owner?.kind === 'agent' ? `agent:${owner.agentId}` : owner?.kind === 'group_project' ? `group_project:${owner.groupProjectId}` : owner?.kind ?? 'unknown';
    let group = groups.get(key);
    if (!group) {
      group = { ...(owner && { owner }), actions: [], runs24h: 0, runs7d: 0, failures24h: 0, failures7d: 0 };
      groups.set(key, group);
    }
    return group;
  };
  const owners = new Map(actions.map((a) => [a.id, a.owner]));
  for (const action of actions) {
    if (action.owner.kind === 'app') continue;
    groupFor(action.owner).actions.push({ id: action.id, name: action.name });
  }
  for (const run of runs) {
    const owner = run.owner ?? owners.get(run.actionId);
    if (owner?.kind === 'app' || run.startedAt > now || now - run.startedAt > 7 * 24 * 60 * 60_000) continue;
    const group = groupFor(owner);
    group.runs7d++;
    if (run.outcome === 'failed') group.failures7d++;
    if (now - run.startedAt <= 24 * 60 * 60_000) {
      group.runs24h++;
      if (run.outcome === 'failed') group.failures24h++;
    }
  }
  return [...groups.values()];
}
