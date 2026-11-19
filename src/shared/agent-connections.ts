/** Pure selected-agent connection rows and words. No stores, IPC, mutations or grants. */
import type { DispatcherLink } from './types';
import type { ConnectionPairSources } from './connection-sources';
import { parseAgentAddress } from './agent-address';
import { dispatcherRoleDisplayName } from './dispatcher-name';

export type ConnectionDirection = 'two-way' | 'to' | 'from';

export interface ConnectionBindingDisplay {
  agentId: string; targetId: string;
  targetKind: 'agent' | 'browser' | 'terminal' | 'group-project' | 'plugin';
  label: string; agentName?: string; targetName?: string; projectName?: string;
}
export interface DispatcherConnectionIdentity { agentId?: string | null; chatAgentId?: string | null; config?: { name?: string } | null }
function connectionDispatcherName(id: string, name: string, state: DispatcherConnectionIdentity | null): string {
  return id === state?.agentId || id === state?.chatAgentId ? dispatcherRoleDisplayName('chat', state?.config?.name || name) : name;
}
export interface Connection {
  /** The other end: an agent id, or the target id for browsers, terminals and group projects. */
  id: string;
  name: string;
  kind: ConnectionBindingDisplay['targetKind'];
  direction: ConnectionDirection;
  /** The other end is one of this agent's helpers, or its orchestrator. */
  family: 'helper' | 'parent' | null;
  /** The bindings behind the row, one per direction. */
  pairs: Array<{ agentId: string; targetId: string }>;
  /** Every binding behind the row was made by the connection tools, and only they list it. */
  toolMade: boolean;
  /** Every pair behind the row is a link the Dispatcher made (#2661). */
  dispatcherMade?: boolean;
  /** Set when the Dispatcher's link is saved but not bound now. */
  suspended?: DispatcherLink['reason'] | true;
  /** An unbound, proven saved automatic direction. No runtime or tool authority. */
  inspectionOnly?: true;
}

const pairKey = (agentId: string, targetId: string) => `${agentId}\u0000${targetId}`;

const KIND_WORD: Record<ConnectionBindingDisplay['targetKind'], string> = {
  agent: 'agent',
  browser: 'browser',
  terminal: 'terminal',
  'group-project': 'group project',
  plugin: 'plugin',
};

/**
 * Every wire touching `agentId`, one row per other end. Agent wires in both
 * directions fold into one two-way row, as the canvas draws them.
 */
export function agentConnections(
  bindings: readonly ConnectionBindingDisplay[],
  agentId: string,
  family: { helperIds: ReadonlySet<string>; parentId?: string },
  toolPairs: ReadonlySet<string> = new Set(),
  dispatcherLinks: readonly DispatcherLink[] = [],
  dispatcher: DispatcherConnectionIdentity | null = null,
  inspectionPairs: readonly ConnectionPairSources[] = [],
): Connection[] {
  const rows = new Map<string, Connection>();
  const links = new Map(dispatcherLinks.map((l) => [pairKey(l.agentId, l.targetId), l]));
  // A suspended link has no binding: it gets a row the same way a wire does.
  const suspended: ConnectionBindingDisplay[] = dispatcherLinks
    .filter((l) => l.status === 'suspended' && !bindings.some((b) => b.agentId === l.agentId && b.targetId === l.targetId))
    .map((l) => ({ agentId: l.agentId, targetId: l.targetId, targetKind: 'agent', label: l.targetName, agentName: l.agentName, targetName: l.targetName }));
  const familyOf = (id: string): Connection['family'] => (family.helperIds.has(id) ? 'helper' : id === family.parentId ? 'parent' : null);
  for (const b of [...bindings, ...suspended]) {
    // A wire to an agent on another machine is listed with those (#3064).
    if (parseAgentAddress(b.targetId).machine) continue;
    if (b.agentId === agentId) {
      const existing = rows.get(b.targetId);
      if (existing) {
        if (existing.direction === 'from') existing.direction = 'two-way';
        existing.pairs.push({ agentId: b.agentId, targetId: b.targetId });
        continue;
      }
      rows.set(b.targetId, {
        pairs: [{ agentId: b.agentId, targetId: b.targetId }],
        toolMade: false,
        id: b.targetId,
        name: b.targetKind === 'group-project' ? (b.projectName || b.targetName || b.label)
          : b.targetKind === 'agent' ? connectionDispatcherName(b.targetId, b.targetName || b.label, dispatcher) : (b.targetName || b.label),
        kind: b.targetKind,
        direction: 'to',
        family: b.targetKind === 'agent' ? familyOf(b.targetId) : null,
      });
    } else if (b.targetKind === 'agent' && b.targetId === agentId) {
      const existing = rows.get(b.agentId);
      if (existing) {
        if (existing.direction === 'to') existing.direction = 'two-way';
        existing.pairs.push({ agentId: b.agentId, targetId: b.targetId });
        continue;
      }
      rows.set(b.agentId, {
        id: b.agentId, name: connectionDispatcherName(b.agentId, b.agentName || b.agentId, dispatcher), kind: 'agent', direction: 'from', family: familyOf(b.agentId),
        pairs: [{ agentId: b.agentId, targetId: b.targetId }], toolMade: false,
      });
    }
  }
  const listed = new Set([...rows.values()].flatMap((row) => row.pairs.map((pair) => pairKey(pair.agentId, pair.targetId))));
  for (const pair of inspectionPairs) {
    if (!pair.inspection || pair.bound || listed.has(pairKey(pair.agentId, pair.targetId))
      || !pair.sources.some((source) => source.kind === 'dispatcher_auto') || parseAgentAddress(pair.targetId).machine) continue;
    const outgoing = pair.agentId === agentId;
    if (!outgoing && pair.targetId !== agentId) continue;
    const id = outgoing ? pair.targetId : pair.agentId;
    const direction = outgoing ? 'to' : 'from';
    const existing = rows.get(id);
    if (existing) {
      if (existing.direction !== direction) existing.direction = 'two-way';
      existing.pairs.push({ agentId: pair.agentId, targetId: pair.targetId });
    } else {
      rows.set(id, {
        id, name: connectionDispatcherName(id, outgoing ? pair.inspection.targetName : pair.inspection.agentName, dispatcher),
        kind: 'agent', direction, family: familyOf(id), pairs: [{ agentId: pair.agentId, targetId: pair.targetId }],
        toolMade: false, inspectionOnly: true,
      });
    }
    listed.add(pairKey(pair.agentId, pair.targetId));
  }
  for (const row of rows.values()) {
    if (row.inspectionOnly) continue;
    const rowLinks = row.pairs.map((p) => links.get(pairKey(p.agentId, p.targetId)));
    row.dispatcherMade = row.family === null && rowLinks.every((l) => !!l);
    row.toolMade = row.dispatcherMade || (row.family === null && row.pairs.every((p) => toolPairs.has(pairKey(p.agentId, p.targetId))));
    if (row.dispatcherMade && rowLinks.every((l) => l?.status === 'suspended')) row.suspended = rowLinks[0]?.reason ?? true;
  }
  // Family first (parent, then helpers), then group projects, then the rest by name.
  const rank = (c: Connection) => (c.family === 'parent' ? 0 : c.family === 'helper' ? 1 : c.kind === 'group-project' ? 2 : 3);
  return [...rows.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** The meta text after a connection's name. */
export function connectionMeta(c: Connection): string {
  if (c.inspectionOnly) return `configured ${c.direction === 'two-way' ? 'two-way' : c.direction === 'to' ? 'outgoing' : 'incoming'}, suspended, not connected`;
  if (c.kind !== 'agent') return KIND_WORD[c.kind];
  const dir = c.direction === 'two-way' ? 'two-way' : c.direction === 'to' ? 'sends to it' : 'sends to this agent';
  if (c.family === 'helper') return `helper, ${dir}`;
  if (c.family === 'parent') return `orchestrator, ${dir}`;
  if (c.dispatcherMade) return c.suspended ? `Dispatcher, ${dir}, suspended` : `Dispatcher, ${dir}`;
  return dir;
}

const SUSPENDED_WHY: Record<NonNullable<DispatcherLink['reason']>, string> = {
  dispatcher_off: 'The Dispatcher is off.',
  store_unwritable: 'Clubhouse can\u2019t save to its connections file.',
  not_connected_to_dispatcher: 'One of these agents is not connected to the Dispatcher.',
};

/** Why a suspended link isn't connected now, for the row's tooltip. */
export function suspendedNote(c: Connection): string | undefined {
  if (!c.suspended) return undefined;
  const why = c.suspended === true ? 'One of these agents can\u2019t use it now.' : SUSPENDED_WHY[c.suspended];
  return `${why} It reconnects by itself when that changes, unless you remove it.`;
}

