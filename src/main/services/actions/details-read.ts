/** Selected read-only Details projection. No engine initialization or receipt refresh. */
import { agentActionGroups, ACTION_OUTCOMES, isActionRunTime, type RemoteActionRow } from '../../../shared/agent-action-groups';
import { describeAction, type ActionNames } from '../../../shared/actions';
import { REMOTE_DETAILS_MAX_ROWS, type RemoteDetailsCard } from '../../../shared/remote-agent-details';
import type { ActionsEngine } from './engine';
import { card, row, display } from '../remote-details-presentation';

export function projectActionDetails(engine: Pick<ActionsEngine, 'list' | 'lastRunForDisplay'>, agentId: string, projectId: string | undefined, dispatcher: boolean, names: ActionNames): Pick<RemoteDetailsCard, 'rows' | 'summary' | 'notes' | 'omitted'> {
  const all = engine.list().filter((a) => a.owner.kind !== 'app');
  const c = card('actions', 'Actions');
  const groups = agentActionGroups(all, agentId, projectId);
  const selected = dispatcher ? [{ group: 'dispatcher' as const, list: all.filter((a) => a.owner.kind === 'dispatcher') }]
    : [{ group: 'owned' as const, list: groups.owned }, { group: 'targeting' as const, list: groups.targeting }, { group: 'triggered-by' as const, list: groups.triggeredBy }];
  const count = new Set(selected.flatMap((group) => group.list.map((a) => a.id))).size;
  c.summary = `${count} ${dispatcher ? 'made by the Dispatcher' : 'related'}`;
  const relationships = new Map<typeof all[number], string[]>();
  for (const group of selected) for (const a of group.list) {
    const words = relationships.get(a) ?? []; words.push(group.group === 'owned' ? 'Owned by this agent' : group.group === 'targeting' ? 'Targets this agent' : 'Set off by this agent'); relationships.set(a, words);
  }
  const lastRuns = new Map<string, ReturnType<ActionsEngine['lastRunForDisplay']>>();
  for (const group of selected) for (const a of group.list) {
    if (c.rows.length >= REMOTE_DETAILS_MAX_ROWS) { c.omitted++; continue; }
    if (!lastRuns.has(a.id)) lastRuns.set(a.id, engine.lastRunForDisplay(a.id));
    const lastRun = lastRuns.get(a.id);
    const before = c.rows.length;
    const description = describeAction(a, names);
    // Keep the original plain row useful to older clients that ignore metadata.
    row(c, a.name, [a.enabled ? 'On' : 'Off', ...(!dispatcher ? relationships.get(a) ?? [] : []), description, lastRun?.outcome].filter(Boolean).join(' · '));
    if (c.rows.length === before) continue;
    const fields: RemoteActionRow = { group: group.group, enabled: a.enabled, description: display(description) };
    if (lastRun && ACTION_OUTCOMES.includes(lastRun.outcome)) {
      fields.lastRun = { outcome: lastRun.outcome };
      if (isActionRunTime(lastRun.startedAt)) fields.lastRun.startedAt = lastRun.startedAt;
    }
    c.rows[c.rows.length - 1].action = fields;
  }
  if (!count) c.notes.push(dispatcher ? 'No actions made by the Dispatcher.' : 'No actions are owned by, target or are set off by this agent.');
  if (c.rows.some((r) => r.action?.lastRun)) c.notes.push('Last-run outcomes are the host’s recorded history; a remote delivery may have changed since it was recorded.');
  return { rows: c.rows, summary: c.summary, notes: c.notes, omitted: c.omitted };
}
