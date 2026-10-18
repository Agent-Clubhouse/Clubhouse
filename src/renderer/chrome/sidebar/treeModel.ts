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
 * `items` most recent first by `activity` (#2116). Items with no activity
 * yet go last, and ties keep their given (manual) order.
 */
export function sortByRecent<T extends { id: string }>(items: readonly T[], activity: Readonly<Record<string, number>>): T[] {
  return items
    .map((item, i) => ({ item, i, at: activity[item.id] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : b.at - a.at))
    .map((e) => e.item);
}

/**
 * `items` in the order of `heldIds`, then any items that are new since, in
 * their own order. Keeps rows from moving under the pointer while the Recent
 * order changes (#2116).
 */
export function holdOrder<T extends { id: string }>(items: readonly T[], heldIds: readonly string[]): T[] {
  const rank = new Map(heldIds.map((id, i) => [id, i]));
  const held = items.filter((item) => rank.has(item.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...held, ...items.filter((item) => !rank.has(item.id))];
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
  // Every group member must have a slot in the order, or one would be lost.
  if (group.some((id) => !order.includes(id))) return null;
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

type NestableAgent = Pick<Agent, 'id' | 'kind' | 'status' | 'parentAgentId'>;

/** A durable agent and the helpers nested under it (#2231). */
export interface AgentNode<A extends NestableAgent = Agent> {
  agent: A;
  children: AgentNode<A>[];
}

export interface ProjectAgentTree<A extends NestableAgent = Agent> {
  /** Top-level durable agents with something awake in their subtree, in saved order. */
  awake: AgentNode<A>[];
  /** Top-level durable agents whose whole subtree is asleep; folded into one row. */
  sleeping: AgentNode<A>[];
  /** Running quick agents, not nested. */
  quick: A[];
}

/**
 * A project's agents as the sidebar tree shows them (#2231). Durable helpers
 * nest under their parent, at any depth, keeping the given order among
 * siblings. A helper stays under its parent whether it is awake or asleep;
 * a top-level agent goes in the sleeping fold only when it and every helper
 * under it are asleep, so nothing working hides in the fold. A helper whose
 * parent isn't in the list (or a parent link that loops) shows at the top level.
 */
export function buildProjectTree<A extends NestableAgent>(agents: readonly A[]): ProjectAgentTree<A> {
  const durable = agents.filter((a) => a.kind === 'durable');
  const byId = new Map(durable.map((a) => [a.id, a]));
  // The parent each agent nests under, or undefined at the top level.
  const parentOf = new Map<string, string | undefined>();
  for (const agent of durable) {
    // Walk up the links; an agent the walk comes back to is in a loop, and shows at the top.
    const seen = new Set<string>();
    let parent = agent.parentAgentId;
    while (parent && byId.has(parent) && !seen.has(parent) && parent !== agent.id) {
      seen.add(parent);
      parent = byId.get(parent)!.parentAgentId;
    }
    const inLoop = parent === agent.id;
    parentOf.set(agent.id, !inLoop && agent.parentAgentId && byId.has(agent.parentAgentId) ? agent.parentAgentId : undefined);
  }
  const childrenOf = new Map<string | undefined, A[]>();
  for (const agent of durable) {
    const parent = parentOf.get(agent.id);
    const siblings = childrenOf.get(parent);
    if (siblings) siblings.push(agent);
    else childrenOf.set(parent, [agent]);
  }
  const node = (agent: A): AgentNode<A> => ({ agent, children: (childrenOf.get(agent.id) ?? []).map(node) });
  const roots = (childrenOf.get(undefined) ?? []).map(node);
  const allAsleep = (n: AgentNode<A>): boolean => n.agent.status === 'sleeping' && n.children.every(allAsleep);
  return {
    awake: roots.filter((n) => !allAsleep(n)),
    sleeping: roots.filter(allAsleep),
    quick: agents.filter((a) => a.kind === 'quick'),
  };
}

/** Every agent under `node`, depth first, not counting the node itself. */
export function descendants<A extends NestableAgent>(node: AgentNode<A>, into: A[] = []): A[] {
  for (const child of node.children) {
    into.push(child.agent);
    descendants(child, into);
  }
  return into;
}

/** How many agents are under `node`, at any depth. */
export function countDescendants(node: AgentNode<NestableAgent>): number {
  let n = 0;
  for (const child of node.children) n += 1 + countDescendants(child);
  return n;
}

/**
 * The groups an agent can be reordered within (#2231): the awake top-level
 * agents, the sleeping top-level agents, and each agent's own helpers. A drag
 * or Move up / Move down never moves a helper to another parent.
 */
export function siblingGroups<A extends NestableAgent>(tree: ProjectAgentTree<A>): string[][] {
  const groups: string[][] = [];
  const walk = (nodes: AgentNode<A>[]) => {
    if (nodes.length > 0) groups.push(nodes.map((n) => n.agent.id));
    nodes.forEach((n) => walk(n.children));
  };
  walk(tree.awake);
  walk(tree.sleeping);
  return groups;
}

/** What a folded parent shows for its helpers (#2231): how many, and whether any wants you or is working. */
export interface HelperRollup {
  count: number;
  needs: number;
  working: number;
}

export function helperRollup(node: AgentNode, detailed: Record<string, AgentDetailedStatus>): HelperRollup {
  const all = descendants(node);
  let needs = 0;
  let working = 0;
  for (const agent of all) {
    const dot = agentDot(agent, detailed[agent.id]);
    if (dot === 'needs' || dot === 'error') needs++;
    else if (dot === 'working') working++;
  }
  return { count: all.length, needs, working };
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
