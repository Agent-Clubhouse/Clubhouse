/**
 * The plain words of an agent's Dispatcher card (#3049): what the Dispatcher
 * can do to this agent, from its real Clubhouse permissions (#2921).
 *
 * Grants have no per-agent target. What reaches this agent is the
 * Dispatcher's grants on agents connected to it, and those on every agent. A
 * grant on every agent can't be narrowed from one agent's card, so those rows
 * show as set elsewhere.
 */

import type { GrantAction, GrantTarget } from '../../../../shared/agent-grants';
import type { AgentGrantsView, GrantChangeMode, GrantRow } from '../../../../shared/agent-grant-changes';

/** The actions that act on an agent, most telling first, with how the card says each. */
export const DISPATCHER_REACH: ReadonlyArray<{ action: GrantAction; verb: string; label: string }> = [
  { action: 'agent.message', verb: 'message it', label: 'Message' },
  { action: 'agent.wake', verb: 'wake it', label: 'Wake' },
  { action: 'agent.sleep', verb: 'put it to sleep', label: 'Put to sleep' },
  { action: 'agent.reset', verb: 'clear its context', label: 'Clear its context' },
  { action: 'agent.restart', verb: 'restart it', label: 'Restart' },
  { action: 'agent.read', verb: 'see its status and output', label: 'See status and output' },
  { action: 'agent.display', verb: 'change its name and look', label: 'Change name and look' },
  { action: 'agent.configure', verb: 'change its model', label: 'Change CLI and model' },
  { action: 'agent.grant', verb: 'change its setup and permissions', label: 'Change setup and permissions' },
  { action: 'connection.manage', verb: 'connect it to other agents', label: 'Make connections' },
];

export const CONNECTED_TARGET: GrantTarget = { kind: 'connected' };

/** One line of the Permissions popover: an action, the mode that reaches this agent, and whether it can change here. */
export interface ReachRow {
  action: GrantAction;
  label: string;
  verb: string;
  mode: GrantChangeMode;
  /** Set on every agent, so it can only change in all of its permissions. */
  everyAgent: boolean;
}

const RANK: Record<GrantChangeMode, number> = { off: 0, ask: 1, allow: 2 };

function isPlainConnected(t: GrantTarget): boolean {
  return t.kind === 'connected' && !t.onlyDispatcher && !t.excludeDispatcher && !t.wakeOn;
}

/**
 * Each agent action, with the Dispatcher's mode on this agent. A grant on
 * every agent that's at least as strong wins and locks the row, since
 * changing the connected row would change nothing.
 */
export function reachRows(view: Pick<AgentGrantsView, 'rows'>): ReachRow[] {
  return DISPATCHER_REACH.map(({ action, verb, label }) => {
    const connected = view.rows.find((r: GrantRow) => r.action === action && isPlainConnected(r.target));
    const any = view.rows.find((r: GrantRow) => r.action === action && r.target.kind === 'any');
    const connectedMode = connected?.mode ?? 'off';
    const anyMode = any?.mode ?? 'off';
    const everyAgent = anyMode !== 'off' && RANK[anyMode] >= RANK[connectedMode];
    return { action, label, verb, mode: everyAgent ? anyMode : connectedMode, everyAgent };
  });
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function sentence(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "Message it, wake it, put it to sleep and 6 more. Asks you first to restart it." */
export function reachSummary(rows: readonly ReachRow[]): string {
  const allowed = rows.filter((r) => r.mode === 'allow').map((r) => r.verb);
  const asks = rows.filter((r) => r.mode === 'ask').map((r) => r.verb);
  const parts: string[] = [];
  if (allowed.length > 0) {
    const shown = allowed.length > 4 ? [...allowed.slice(0, 3), `${allowed.length - 3} more`] : allowed;
    parts.push(`${sentence(joinList(shown))}.`);
  }
  if (asks.length > 0) parts.push(`Asks you first to ${joinList(asks)}.`);
  return parts.length > 0 ? parts.join(' ') : 'Nothing on this agent.';
}
