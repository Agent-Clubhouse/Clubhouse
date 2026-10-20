import type { AgentInfo, PluginAgentDetailedStatus } from '../../../../shared/plugin-types';
import type { Agent, AgentDetailedStatus } from '../../../../shared/types';
import { agentDot, DOT_LABEL, isRemoteAgentId, type AgentDot } from './host';

/**
 * Pure rules behind Review (#2021): the status word for an agent, why the list
 * is empty, and what a key does while browsing. Kept free of React and stores.
 */

export interface ReviewFilters {
  includeSleeping: boolean;
  includeRemote: boolean;
  needsYouOnly: boolean;
}

/** The sidebar's dot for an agent, so Review and the tree use the same status words. */
export function reviewDot(agent: AgentInfo, detailed: PluginAgentDetailedStatus | null | undefined): AgentDot {
  return agentDot(agent as unknown as Agent, (detailed ?? undefined) as AgentDetailedStatus | undefined);
}

export function statusWord(dot: AgentDot): string {
  return DOT_LABEL[dot];
}

export type EmptyCause =
  /** No agents at all in this scope. */
  | { kind: 'no-agents' }
  /** Every agent is asleep and Sleeping is off. */
  | { kind: 'nothing-running'; sleepers: AgentInfo[] }
  /** Needs you only is on and nobody is waiting. */
  | { kind: 'nobody-needs-you'; others: AgentInfo[] }
  /** The Sleeping and Remote filters hide everyone; each count is how many turning that one on would show. */
  | { kind: 'filtered'; total: number; hiddenBySleeping: number; hiddenByRemote: number };

/** Why the filtered list is empty, so the empty state can name the cause and offer the fix. */
export function emptyCause(all: AgentInfo[], filters: ReviewFilters): EmptyCause {
  if (all.length === 0) return { kind: 'no-agents' };
  const passSleeping = (a: AgentInfo) => filters.includeSleeping || a.status !== 'sleeping';
  const passRemote = (a: AgentInfo) => filters.includeRemote || !isRemoteAgentId(a.id);
  const shown = all.filter((a) => passSleeping(a) && passRemote(a));
  if (filters.needsYouOnly && shown.length > 0) return { kind: 'nobody-needs-you', others: shown };
  if (!filters.includeSleeping && all.every((a) => a.status === 'sleeping')) {
    const local = all.filter(passRemote);
    return { kind: 'nothing-running', sleepers: local.length > 0 ? local : all };
  }
  return {
    kind: 'filtered',
    total: all.length,
    hiddenBySleeping: filters.includeSleeping ? 0 : all.filter((a) => a.status === 'sleeping' && passRemote(a)).length,
    hiddenByRemote: filters.includeRemote ? 0 : all.filter((a) => isRemoteAgentId(a.id) && passSleeping(a)).length,
  };
}

export type BrowseAction =
  | { type: 'prev' }
  | { type: 'next' }
  | { type: 'sleep' }
  | { type: 'wake' }
  | { type: 'jump'; index: number }
  | { type: 'jump-list' }
  | { type: 'type' };

/**
 * What a key does while browsing (not typing to the agent). ⌥⌘← and ⌥⌘→ are
 * global commands in the manifest, so they are not handled here.
 */
export function browseAction(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }): BrowseAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowLeft': case 'k': case 'K': return { type: 'prev' };
    case 'ArrowRight': case 'j': case 'J': return { type: 'next' };
    case 's': case 'S': return { type: 'sleep' };
    case 'w': case 'W': return { type: 'wake' };
    case 'g': case 'G': return { type: 'jump-list' };
    case 'Enter': return { type: 'type' };
  }
  if (/^[1-9]$/.test(e.key)) return { type: 'jump', index: Number(e.key) - 1 };
  return null;
}

/** "3h ago", "2d ago": how long since an ISO time. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** "1 agent", "3 agents". */
export function agentCount(n: number): string {
  return `${n} agent${n === 1 ? '' : 's'}`;
}

/** "3 agents are running", "2 agents are running and 1 is asleep", "1 agent is asleep". */
export function describeAgents(agents: AgentInfo[]): string {
  const asleep = agents.filter((a) => a.status === 'sleeping').length;
  const running = agents.length - asleep;
  const verb = (n: number) => (n === 1 ? 'is' : 'are');
  if (running && asleep) return `${agentCount(running)} ${verb(running)} running and ${asleep} ${verb(asleep)} asleep`;
  if (asleep) return `${agentCount(asleep)} ${verb(asleep)} asleep`;
  return `${agentCount(running)} ${verb(running)} running`;
}
