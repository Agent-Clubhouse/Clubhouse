import { agentConnections as projectAgentConnections, connectionMeta, suspendedNote, type Connection } from '../../../../shared/agent-connections';
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
import { ConnectionOpenAction } from './ConnectionOpenAction';
import { CONNECTION_SOURCE_LABELS, type AgentConnectionSources, type ConnectionPairSources } from '../../../../shared/connection-sources';
import { ConnectionSourcesDialog } from './ConnectionSourcesDialog';
import type { ConnectionDirection as SavedDirection } from '../../../../shared/connection-grants';
import { dispatcherAgentDisplayName, isDispatcherAgent, useDispatcherStore } from '../../dispatcher/dispatcherStore';
import { RemoteConnections, remoteConnections } from './RemoteConnections';
import { ConnectionPicker } from './ConnectionPicker';
import { reportChromeActionFailed } from '../../../chrome/telemetry';

export { connectionMeta, suspendedNote, type Connection, type ConnectionDirection } from '../../../../shared/agent-connections';
/** Local default state belongs in this container; the shared model is passive. */
export function agentConnections(...args: Parameters<typeof projectAgentConnections>): Connection[] {
  if (args[5] === undefined) args[5] = useDispatcherStore.getState().state;
  return projectAgentConnections(...args);
}
const pairKey = (agentId: string, targetId: string) => `${agentId}\u0000${targetId}`;

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
  const dispatcher = useDispatcherStore((s) => s.state);
  const connectionAgentId = agent.id === dispatcher?.chatAgentId ? dispatcher.agentId ?? agent.id : agent.id;
  const toolPairs = useToolConnectionPairs(open && !!onDisconnect, bindings);
  // Removing a suspended link changes no binding, so that re-reads the list itself.
  const [removals, setRemovals] = useState(0);
  const dispatcherLinks = useDispatcherLinks(open && !!onDisconnect, bindings, removals);
  // Where each connection comes from (#2744), re-read with the bindings and after a removal.
  const sourceRead = useConnectionSources(open && !!onDisconnect, connectionAgentId, bindings, removals);
  const sources = sourceRead?.sources;
  const connections = useMemo(
    () => agentConnections(bindings, connectionAgentId, { helperIds, parentId }, toolPairs, dispatcherLinks, dispatcher, sources?.pairs),
    [bindings, connectionAgentId, helperIds, parentId, toolPairs, dispatcherLinks, dispatcher, sources],
  );
  const [confirming, setConfirming] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const [remoteManaging, setRemoteManaging] = useState<string | null>(null);
  const grants = useConnectionGrants(open && !!onDisconnect, connectionAgentId, bindings, removals);
  // A connection another computer made or changed changes no binding here, so its change re-reads the store (#3064).
  useEffect(() => {
    if (!open || !onDisconnect) return undefined;
    return window.clubhouse.mcpBinding.onConnectionGrantsChanged(() => setRemovals((n) => n + 1));
  }, [open, onDisconnect]);
  const remoteCount = useMemo(() => remoteConnections(grants, connectionAgentId).length, [grants, connectionAgentId]);
  // The row being managed, by the other end's id: looked up each render so a new direction shows (#2972).
  const [managingId, setManagingId] = useState<string | null>(null);
  const managing = managingId ? connections.find((c) => c.id === managingId) ?? null : null;
  const pairSources = (c: Connection): ConnectionPairSources[] => {
    const pairs = new Map((sources?.pairs ?? []).filter((p) => (p.agentId === connectionAgentId && p.targetId === c.id)
      || (c.kind === 'agent' && p.agentId === c.id && p.targetId === connectionAgentId)).map((p) => [pairKey(p.agentId, p.targetId), p]));
    for (const p of c.pairs) {
      if (pairs.has(pairKey(p.agentId, p.targetId))) continue;
      const bound = bindings.some((b) => b.agentId === p.agentId && b.targetId === p.targetId);
      pairs.set(pairKey(p.agentId, p.targetId), { ...p, bound, sources: [], ...(bound && { unresolved: true }) });
    }
    return [...pairs.values()];
  };

  return (
    <>
    <DetailsCard
      id="connections"
      title="Connections"
      summary={connections.length + remoteCount === 0 ? 'none' : String(connections.length + remoteCount)}
      open={open}
      onToggle={onToggle}
    >
      {onDisconnect && <button type="button" onClick={() => setAdding(true)} className="text-xs text-ctp-text hover:underline mb-2" data-testid="connection-add">Add connection</button>}
      {!managingId && (sourceRead?.error || (sources && sources.unreadable.length > 0 && connections.length === 0)) && (
        <p role="alert" className="text-xs text-ctp-error mb-3">
          Couldn't check saved connection sources: {sourceRead?.error ?? sources?.unreadable.map((id) => CONNECTION_SOURCE_LABELS[id === 'dispatcher-wires' ? 'dispatcher_auto' : id === 'dispatcher-connections' ? 'dispatcher_link' : 'other']).join(', ')}.
          {' '}<button type="button" onClick={() => setRemovals((n) => n + 1)} className="underline">Try again</button>
        </p>
      )}
      {connections.length === 0 && remoteCount > 0 ? null : connections.length === 0 ? (
        <CardNote>No Clubhouse MCP wires. Wires drawn on a canvas, and the ones between an orchestrator and its helpers, show here.</CardNote>
      ) : (
        <ul className="flex flex-col" data-testid="connections-list">
          {connections.map((c) => {
            return (
              <li key={c.id}>
                <div className="w-[calc(100%-28px)] ml-[22px] h-[30px] flex items-center gap-2 pl-3 pr-2.5 rounded-md hover:bg-surface-0" data-testid="connection-row">
                  {/* A fixed name column, so the meta lines up whether or not the name is cut (#3184). */}
                  <span className="w-[96px] flex-shrink-0 text-[12.5px] text-ctp-text truncate" title={c.name} data-testid="connection-name">{c.name}</span>
                  <span className="min-w-0 text-xs text-ctp-overlay1 whitespace-nowrap truncate" title={sourcesNote(pairSources(c)) ?? suspendedNote(c)} data-testid="connection-meta">{connectionMeta(c)}</span>
                  <span className="ml-auto flex-shrink-0 flex items-center gap-2.5">
                    {onDisconnect && sourceRead && (
                      <button type="button" onClick={() => setManagingId(c.id)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="connection-sources">
                        Edit
                      </button>
                    )}
                    {onDisconnect && c.toolMade && c.kind !== 'agent' && (
                      <button type="button" onClick={() => setConfirming(c)} className="text-xs text-ctp-overlay1 hover:text-ctp-text cursor-pointer" data-testid="connection-disconnect">
                        Disconnect
                      </button>
                    )}
                    <ConnectionOpenAction targetId={c.id} targetKind={c.kind} name={c.name} projectId={agent.projectId} sourceAgent={{ id: agent.id, name: agent.name, projectId: agent.projectId }} />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {onDisconnect && <RemoteConnections agent={{ ...agent, id: connectionAgentId }} grants={grants} openAddress={remoteManaging} onChanged={() => setRemovals((n) => n + 1)} />}
    </DetailsCard>
    {adding && <ConnectionPicker agentId={connectionAgentId} agentName={agent.name} bindings={bindings} grants={grants} onClose={() => setAdding(false)} onCreated={(target) => {
      setAdding(false);
      setRemovals((n) => n + 1);
      if (target.machineId) setRemoteManaging(`${target.routeId ?? target.id}@${target.machineId}`);
      else setManagingId(target.routeId ?? target.id);
    }} />}
    {managing && (
      <ConnectionSourcesDialog
        agentId={connectionAgentId}
        otherId={managing.id}
        targetKind={managing.kind}
        grants={grants}
        liveTools={new Map(bindings.map((b) => [`${b.agentId}>${b.targetId}`, b.disabledTools ?? []]))}
        liveEnabled={new Map(bindings.map((b) => [`${b.agentId}>${b.targetId}`, b.enabledTools ?? []]))}
        agentName={dispatcherAgentDisplayName(connectionAgentId, agent.name, dispatcher)}
        otherName={dispatcherAgentDisplayName(managing.id, rail[managing.id]?.name ?? managing.name, dispatcher)}
        dispatcherEnd={isDispatcherAgent(agent) ? managing.name : managing.id === dispatcher?.agentId || managing.id === dispatcher?.chatAgentId
          || (rail[managing.id] && isDispatcherAgent(rail[managing.id])) ? agent.name : undefined}
        familyLink={managing.family !== null}
        pairs={pairSources(managing)}
        unreadable={sources?.unreadable ?? []}
        readError={sourceRead?.error}
        onRetry={() => setRemovals((n) => n + 1)}
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

/** Last-known sources and explicit read errors; null until the first read settles. */
function useConnectionSources(active: boolean, agentId: string, bindings: readonly McpBindingEntry[], removals: number) {
  const [read, setRead] = useState<{ sources: AgentConnectionSources | null; error?: string } | null>(null);
  useEffect(() => {
    if (!active) { setRead(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.mcpBinding.getConnectionSources(agentId)).then(
      (list) => { if (alive) setRead({ sources: list }); },
      (error: unknown) => {
        reportChromeActionFailed('agent_settings_save', error);
        if (alive) setRead((before) => ({ sources: before?.sources ?? null, error: error instanceof Error ? error.message : String(error) }));
      },
    );
    return () => { alive = false; };
  }, [active, agentId, bindings, removals]);
  return read;
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
