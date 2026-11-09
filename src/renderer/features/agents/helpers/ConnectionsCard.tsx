/**
 * The Connections card in Agent details (#2232): the agent's Clubhouse MCP
 * wires, from the binding store the canvas draws from, listed the way the
 * Canvases card lists boards. An agent wired both ways reads "two-way", as a
 * bidirectional canvas wire does; the orchestrator ↔ helper wires (#2225)
 * read "helper, two-way".
 *
 * Wires the orchestrator's connection tools made (#2230) can be removed
 * here, as a user removal: `onDisconnect` unbinds them the way deleting a
 * canvas wire does, so the tools can't make them again. Canvas wires, helper
 * wires and anything another source also lists stay read-only; main says
 * which wires the tools alone own.
 *
 * Links the Dispatcher made (#2661) read as the Dispatcher's and can be removed
 * the same way. A suspended one has no binding, so its row comes from main's
 * list: it shows here so its return is never a surprise.
 */

import { useEffect, useMemo, useState } from 'react';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import type { Agent, DispatcherLink } from '../../../../shared/types';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { useAgentStore } from '../../../stores/agentStore';
import { CardNote, DetailsCard } from '../details/DetailsCard';
import { openAgent } from './orchestration-hooks';
import { CONNECTION_SOURCE_LABELS, type AgentConnectionSources, type ConnectionPairSources } from '../../../../shared/connection-sources';
import { ConnectionSourcesDialog } from './ConnectionSourcesDialog';
import type { ConnectionDirection as SavedDirection } from '../../../../shared/connection-grants';
import { isDispatcherAgent } from '../../dispatcher/dispatcherStore';
import { parseAgentAddress } from '../../../../shared/agent-address';
import { RemoteConnections, remoteConnections } from './RemoteConnections';

export type ConnectionDirection = 'two-way' | 'to' | 'from';

export interface Connection {
  /** The other end: an agent id, or the target id for browsers, terminals and group projects. */
  id: string;
  name: string;
  kind: McpBindingEntry['targetKind'];
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
}

const pairKey = (agentId: string, targetId: string) => `${agentId}\u0000${targetId}`;

const KIND_WORD: Record<McpBindingEntry['targetKind'], string> = {
  agent: 'agent',
  browser: 'browser',
  terminal: 'terminal',
  'group-project': 'group project',
};

/**
 * Every wire touching `agentId`, one row per other end. Agent wires in both
 * directions fold into one two-way row, as the canvas draws them.
 */
export function agentConnections(
  bindings: readonly McpBindingEntry[],
  agentId: string,
  family: { helperIds: ReadonlySet<string>; parentId?: string },
  toolPairs: ReadonlySet<string> = new Set(),
  dispatcherLinks: readonly DispatcherLink[] = [],
): Connection[] {
  const rows = new Map<string, Connection>();
  const links = new Map(dispatcherLinks.map((l) => [pairKey(l.agentId, l.targetId), l]));
  // A suspended link has no binding: it gets a row the same way a wire does.
  const suspended: McpBindingEntry[] = dispatcherLinks
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
        name: b.targetKind === 'group-project' ? (b.projectName || b.targetName || b.label) : (b.targetName || b.label),
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
        id: b.agentId, name: b.agentName || b.agentId, kind: 'agent', direction: 'from', family: familyOf(b.agentId),
        pairs: [{ agentId: b.agentId, targetId: b.targetId }], toolMade: false,
      });
    }
  }
  for (const row of rows.values()) {
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
  orchestration_off: 'Orchestration is off for one of these agents.',
  not_connected_to_dispatcher: 'One of these agents is not connected to the Dispatcher.',
};

/** Why a suspended link isn't connected now, for the row's tooltip. */
export function suspendedNote(c: Connection): string | undefined {
  if (!c.suspended) return undefined;
  const why = c.suspended === true ? 'One of these agents can\u2019t use it now.' : SUSPENDED_WHY[c.suspended];
  return `${why} It reconnects by itself when that changes, unless you remove it.`;
}

export function ConnectionsCard({ agent, helperIds, parentId, open, onToggle, onDisconnect }: {
  agent: Agent;
  helperIds: ReadonlySet<string>;
  parentId?: string;
  open: boolean;
  onToggle: () => void;
  /** Remove a tool-made wire as the user (#2230). Without it the card is read-only. */
  onDisconnect?: (connection: Connection) => void | Promise<void>;
}) {
  const bindings = useMcpBindingStore((s) => s.bindings);
  const rail = useAgentStore((s) => s.agents);
  const toolPairs = useToolConnectionPairs(open && !!onDisconnect, bindings);
  // Removing a suspended link changes no binding, so that re-reads the list itself.
  const [removals, setRemovals] = useState(0);
  const dispatcherLinks = useDispatcherLinks(open && !!onDisconnect, bindings, removals);
  const connections = useMemo(
    () => agentConnections(bindings, agent.id, { helperIds, parentId }, toolPairs, dispatcherLinks),
    [bindings, agent.id, helperIds, parentId, toolPairs, dispatcherLinks],
  );
  const [confirming, setConfirming] = useState<Connection | null>(null);
  // Where each connection comes from (#2744), re-read with the bindings and after a removal.
  const sources = useConnectionSources(open && !!onDisconnect, agent.id, bindings, removals);
  const grants = useConnectionGrants(open && !!onDisconnect, agent.id, bindings, removals);
  // A connection another computer made or changed changes no binding here, so its change re-reads the store (#3064).
  useEffect(() => {
    if (!open || !onDisconnect) return undefined;
    return window.clubhouse.mcpBinding.onConnectionGrantsChanged(() => setRemovals((n) => n + 1));
  }, [open, onDisconnect]);
  const remoteCount = useMemo(() => remoteConnections(grants, agent.id).length, [grants, agent.id]);
  // The row being managed, by the other end's id: looked up each render so a new direction shows (#2972).
  const [managingId, setManagingId] = useState<string | null>(null);
  const managing = managingId ? connections.find((c) => c.id === managingId) ?? null : null;
  const pairSources = (c: Connection): ConnectionPairSources[] =>
    c.pairs.map((p) => sources?.pairs.find((s) => s.agentId === p.agentId && s.targetId === p.targetId)).filter((s): s is ConnectionPairSources => !!s);

  return (
    <>
    <DetailsCard
      id="connections"
      title="Connections"
      summary={connections.length + remoteCount === 0 ? 'none' : String(connections.length + remoteCount)}
      open={open}
      onToggle={onToggle}
    >
      {connections.length === 0 && remoteCount > 0 ? null : connections.length === 0 ? (
        <CardNote>No Clubhouse MCP wires. Wires drawn on a canvas, and the ones between an orchestrator and its helpers, show here.</CardNote>
      ) : (
        <ul className="flex flex-col" data-testid="connections-list">
          {connections.map((c) => {
            const openable = c.kind === 'agent' && !!rail[c.id];
            return (
              <li key={c.id}>
                <div className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md hover:bg-surface-0" data-testid="connection-row">
                  {/* A fixed name column, so the meta lines up whether or not the name is cut (#3184). */}
                  <span className="w-[96px] flex-shrink-0 text-[12.5px] text-ctp-text truncate" title={c.name} data-testid="connection-name">{c.name}</span>
                  <span className="min-w-0 text-xs text-ctp-overlay1 whitespace-nowrap truncate" title={sourcesNote(pairSources(c)) ?? suspendedNote(c)} data-testid="connection-meta">{connectionMeta(c)}</span>
                  <span className="ml-auto flex-shrink-0 flex items-center gap-2.5">
                    {onDisconnect && c.kind === 'agent' && pairSources(c).length > 0 && (
                      <button type="button" onClick={() => setManagingId(c.id)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="connection-sources">
                        Manage
                      </button>
                    )}
                    {onDisconnect && c.toolMade && c.kind !== 'agent' && (
                      <button type="button" onClick={() => setConfirming(c)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="connection-disconnect">
                        Disconnect
                      </button>
                    )}
                    {openable && (
                      <button type="button" onClick={() => openAgent(rail[c.id].projectId, c.id)} className="text-xs text-ctp-accent hover:underline cursor-pointer" data-testid="connection-open">
                        Open
                      </button>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {onDisconnect && <RemoteConnections agent={agent} grants={grants} onChanged={() => setRemovals((n) => n + 1)} />}
    </DetailsCard>
    {managing && (
      <ConnectionSourcesDialog
        agentId={agent.id}
        otherId={managing.id}
        grants={grants}
        liveTools={new Map(bindings.filter((b) => b.targetKind === 'agent').map((b) => [`${b.agentId}>${b.targetId}`, b.disabledTools ?? []]))}
        agentName={agent.name}
        otherName={rail[managing.id]?.name ?? managing.name}
        dispatcherEnd={isDispatcherAgent(agent) ? managing.name : rail[managing.id] && isDispatcherAgent(rail[managing.id]) ? agent.name : undefined}
        pairs={(sources?.pairs ?? []).filter((p) => (p.agentId === agent.id && p.targetId === managing.id) || (p.agentId === managing.id && p.targetId === agent.id))}
        unreadable={sources?.unreadable ?? []}
        onClose={() => setManagingId(null)}
        onRemoved={() => setRemovals((n) => n + 1)}
      />
    )}
    <ConfirmDestructiveAction
      open={confirming !== null}
      title={`Disconnect ${confirming?.name ?? ''}?`}
      description={confirming?.dispatcherMade
        ? 'The Dispatcher made this connection. Removing it here counts as your removal, so the Dispatcher can’t connect them again unless you draw it yourself.'
        : `${agent.name} made this connection with its tools. Removing it here counts as your removal, so ${agent.name} can’t connect them again this session.`}
      confirmLabel="Disconnect"
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        const c = confirming;
        setConfirming(null);
        if (c && onDisconnect) void Promise.resolve(onDisconnect(c)).finally(() => setRemovals((n) => n + 1));
      }}
    />
    </>
  );
}

/**
 * The pairs the connection tools alone own, re-read while the card is open
 * and the bindings change. Empty when nothing can be disconnected.
 */
function useToolConnectionPairs(active: boolean, bindings: readonly McpBindingEntry[]): ReadonlySet<string> {
  const [pairs, setPairs] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!active) { setPairs(new Set()); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.mcpBinding.getToolConnections()).then(
      (list) => { if (alive) setPairs(new Set((list ?? []).map((p) => pairKey(p.agentId, p.targetId)))); },
      // telemetry-exempt: the card stays read-only.
      () => { if (alive) setPairs(new Set()); },
    );
    return () => { alive = false; };
  }, [active, bindings]);
  return pairs;
}

/** "From: Canvas wire, Connect to Dispatcher", for a row's tooltip (#2744). */
export function sourcesNote(pairs: readonly ConnectionPairSources[]): string | undefined {
  const kinds = [...new Set(pairs.flatMap((p) => p.sources.map((s) => s.kind)))];
  if (kinds.length === 0) return pairs.some((p) => p.unresolved) ? 'Connected now, but no saved source lists it.' : undefined;
  return `From: ${kinds.map((k) => CONNECTION_SOURCE_LABELS[k]).join(', ')}`;
}

/** The sources behind the agent's connections, re-read like the tool pairs. Null until read, or when they can't be. */
function useConnectionSources(active: boolean, agentId: string, bindings: readonly McpBindingEntry[], removals: number): AgentConnectionSources | null {
  const [sources, setSources] = useState<AgentConnectionSources | null>(null);
  useEffect(() => {
    if (!active) { setSources(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.mcpBinding.getConnectionSources(agentId)).then(
      (list) => { if (alive) setSources(list ?? null); },
      // telemetry-exempt: the card shows its rows without sources.
      () => { if (alive) setSources(null); },
    );
    return () => { alive = false; };
  }, [active, agentId, bindings, removals]);
  return sources;
}

/** Saved per-direction permissions touching the agent (D129), re-read like the sources. */
function useConnectionGrants(active: boolean, agentId: string, bindings: readonly McpBindingEntry[], removals: number): readonly SavedDirection[] {
  const [grants, setGrants] = useState<readonly SavedDirection[]>([]);
  useEffect(() => {
    if (!active) { setGrants([]); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.mcpBinding.getConnectionGrants(agentId)).then(
      (list) => { if (alive) setGrants(list ?? []); },
      // telemetry-exempt: the view falls back to the live bindings' lists.
      () => { if (alive) setGrants([]); },
    );
    return () => { alive = false; };
  }, [active, agentId, bindings, removals]);
  return grants;
}

/** The Dispatcher's links, re-read like the tool pairs. Empty when they can't be read. */
function useDispatcherLinks(active: boolean, bindings: readonly McpBindingEntry[], removals: number): readonly DispatcherLink[] {
  const [links, setLinks] = useState<readonly DispatcherLink[]>([]);
  useEffect(() => {
    if (!active) { setLinks([]); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.mcpBinding.getDispatcherLinks()).then(
      (list) => { if (alive) setLinks(list ?? []); },
      // telemetry-exempt: the card shows the wires it has.
      () => { if (alive) setLinks([]); },
    );
    return () => { alive = false; };
  }, [active, bindings, removals]);
  return links;
}
