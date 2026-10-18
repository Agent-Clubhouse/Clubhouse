import type { Agent, AgentDetailedStatus } from '../../../shared/types';
import { agentDot } from '../../features/agents/agent-status';

/**
 * Pure helpers behind the sidebar tree (docs/chrome-redesign-spec.md §4.2).
 * Kept free of React and stores so ordering and grouping rules are unit-tested
 * on their own.
 */

/** What the status dot on a row shows; shared with every status surface (#2018). */
export { agentDot, type AgentDot } from '../../features/agents/agent-status';

export interface NeedsAttentionItem {
  agent: Agent;
  reason: 'permission' | 'tool_error' | 'error';
  message: string;
  /** When the agent started waiting, for ordering across hosts. */
  at: number;
  /** The satellite the agent runs on; absent for the local host. */
  hostId?: string;
  hostLabel?: string;
}

/**
 * Agents waiting on the user, across every given project. Mirrors the old Home
 * "Needs attention" rule: a permission prompt, a failed tool, or an errored agent.
 */
export function selectNeedsAttention(
  agents: Record<string, Agent>,
  detailed: Record<string, AgentDetailedStatus>,
  projectIds: ReadonlySet<string>,
): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];
  for (const agent of Object.values(agents)) {
    if (!projectIds.has(agent.projectId)) continue;
    const d = detailed[agent.id];
    const at = d?.timestamp ?? 0;
    if (d?.state === 'needs_permission') {
      items.push({ agent, at, reason: 'permission', message: d.message || (d.toolName ? `Wants to use ${d.toolName}` : 'Waiting for permission') });
    } else if (d?.state === 'tool_error') {
      items.push({ agent, at, reason: 'tool_error', message: d.message || (d.toolName ? `${d.toolName} failed` : 'A tool failed') });
    } else if (agent.status === 'error') {
      items.push({ agent, at, reason: 'error', message: agent.errorMessage || 'Stopped with an error' });
    }
  }
  // Oldest request first, so the queue reads in the order things happened.
  return items.sort((a, b) => a.at - b.at);
}

/**
 * The same rule across every connected satellite (spec §2, hosts option 1), each
 * item tagged with its host. Remote agents and statuses are keyed by namespaced
 * id, and a satellite's projects by its id (remoteProjectStore).
 */
export function selectRemoteNeedsAttention(
  satellites: ReadonlyArray<{ id: string; alias: string; state: string }>,
  satelliteProjects: Record<string, ReadonlyArray<{ id: string }>>,
  remoteAgents: Record<string, Agent>,
  remoteDetailed: Record<string, AgentDetailedStatus>,
): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];
  for (const sat of satellites) {
    if (sat.state !== 'connected') continue;
    const projectIds = new Set((satelliteProjects[sat.id] ?? []).map((p) => p.id));
    if (projectIds.size === 0) continue;
    for (const item of selectNeedsAttention(remoteAgents, remoteDetailed, projectIds)) {
      items.push({ ...item, hostId: sat.id, hostLabel: sat.alias });
    }
  }
  return items;
}

/** Local and remote items in one queue, oldest first. */
export function mergeNeedsAttention(...lists: NeedsAttentionItem[][]): NeedsAttentionItem[] {
  return lists.flat().sort((a, b) => a.at - b.at);
}

/** Pinned projects first (in project order), then the rest (in project order). */
export function orderProjects<T extends { id: string }>(projects: T[], pinnedIds: readonly string[]): { pinned: T[]; rest: T[] } {
  const pinnedSet = new Set(pinnedIds);
  return {
    pinned: projects.filter((p) => pinnedSet.has(p.id)),
    rest: projects.filter((p) => !pinnedSet.has(p.id)),
  };
}

/**
 * Move `draggedId` to sit before `targetId` in the full project order. Returns
 * null when nothing changes, so callers can skip a write.
 */
export function moveProject(orderedIds: readonly string[], draggedId: string, targetId: string): string[] | null {
  if (draggedId === targetId) return null;
  const from = orderedIds.indexOf(draggedId);
  const to = orderedIds.indexOf(targetId);
  if (from === -1 || to === -1) return null;
  const next = orderedIds.filter((id) => id !== draggedId);
  next.splice(next.indexOf(targetId), 0, draggedId);
  return next.every((id, i) => id === orderedIds[i]) ? null : next;
}

/**
 * Move `draggedId` onto `targetId` inside one group of agents (the awake ones,
 * or the sleeping ones), and write the group's new order back into the full
 * saved order at the same places, so agents outside the group keep theirs.
 * Moving down lands after the target and moving up lands before it, so either
 * end of the group can be reached. Returns null when nothing changes.
 */
export function moveWithinGroup(
  order: readonly string[],
  group: readonly string[],
  draggedId: string,
  targetId: string,
): string[] | null {
  const from = group.indexOf(draggedId);
  const to = group.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const reordered = group.filter((id) => id !== draggedId);
  reordered.splice(to, 0, draggedId);
  const next = [...order];
  group.forEach((id, k) => {
    const slot = order.indexOf(id);
    if (slot !== -1) next[slot] = reordered[k];
  });
  return next.every((id, i) => id === order[i]) ? null : next;
}

export interface ProjectAgentGroups {
  /** Durable agents that are not asleep, in saved order. */
  durable: Agent[];
  /** Durable agents that are asleep; folded into one row. */
  sleeping: Agent[];
  /** Running quick agents. */
  quick: Agent[];
}

export function groupProjectAgents(agents: Agent[]): ProjectAgentGroups {
  const durable: Agent[] = [];
  const sleeping: Agent[] = [];
  const quick: Agent[] = [];
  for (const agent of agents) {
    if (agent.kind === 'quick') quick.push(agent);
    else if (agent.kind === 'durable' && agent.status === 'sleeping') sleeping.push(agent);
    else if (agent.kind === 'durable') durable.push(agent);
  }
  return { durable, sleeping, quick };
}

export interface ProjectRollup { working: number; waiting: number }

export function projectRollup(agents: Agent[], detailed: Record<string, AgentDetailedStatus>): ProjectRollup {
  let working = 0;
  let waiting = 0;
  for (const agent of agents) {
    const dot = agentDot(agent, detailed[agent.id]);
    if (dot === 'working') working++;
    else if (dot === 'needs' || dot === 'error') waiting++;
  }
  return { working, waiting };
}

export interface FilteredProject<P> {
  project: P;
  /** The project's own name matches. */
  nameMatch: boolean;
  /** Its agents whose names match, awake first, then quick, then sleeping. */
  agents: Agent[];
}

/**
 * The sidebar filter (#2031): projects whose name matches, and agents whose
 * name matches, sleeping ones included, under their project. Case-insensitive
 * substring, in tree order. `count` is matched projects plus matched agents.
 */
export function filterTree<P extends { id: string; name: string; displayName?: string }>(
  query: string,
  projects: P[],
  agentsByProject: Record<string, Agent[]>,
): { groups: FilteredProject<P>[]; count: number } {
  const q = query.trim().toLowerCase();
  const groups: FilteredProject<P>[] = [];
  let count = 0;
  if (!q) return { groups, count };
  for (const project of projects) {
    const nameMatch = (project.displayName || project.name).toLowerCase().includes(q);
    const { durable, quick, sleeping } = groupProjectAgents(agentsByProject[project.id] ?? []);
    const agents = [...durable, ...quick, ...sleeping].filter((a) => a.name.toLowerCase().includes(q));
    if (!nameMatch && agents.length === 0) continue;
    groups.push({ project, nameMatch, agents });
    count += agents.length + (nameMatch ? 1 : 0);
  }
  return { groups, count };
}
