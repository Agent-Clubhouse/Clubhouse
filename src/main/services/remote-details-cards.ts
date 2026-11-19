import type { RemoteDetailsCard } from '../../shared/remote-agent-details';
import { CONNECTION_SOURCE_LABELS } from '../../shared/connection-sources';
import { activeAgentLinks, CONNECTION_SWITCHES, localDirectionTools } from '../../shared/connection-grants';
import { remoteConnections } from '../../shared/remote-connections';
import { getSatellite } from './annex-client';
import { getPeer } from './annex-peers';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { listConnectionSources } from './connection-sources';
import { listConnectionDirectionsForInspection } from './connection-grants-store';
import { readActionDetailsForAgent, actionNames } from './actions';
import { getAgentCanvasMemberships } from './canvas-store-reader';
import { row, display } from './remote-details-presentation';

export async function readConnectionCard(c: RemoteDetailsCard, wiresId: string) {
  const bindings = bindingManager.getAllBindings().filter((b) => b.agentId === wiresId || b.targetKind === 'agent' && b.targetId === wiresId);
  const sources = await listConnectionSources(wiresId);
  const directions = listConnectionDirectionsForInspection(wiresId);
  const remote = remoteConnections(directions, wiresId);
  const pairs = new Map<string, { from: string; to: string; name: string; kind: string; bound: boolean; sources: string[]; disabled?: string[]; enabled?: string[] }>();
  const key = (from: string, to: string) => `${from}\0${to}`;
  for (const b of bindings) pairs.set(key(b.agentId, b.targetId), { from: b.agentId, to: b.targetId, name: b.agentId === wiresId ? b.targetName || b.projectName || b.label : b.agentName || b.agentId, kind: b.targetKind, bound: true, sources: [], disabled: b.disabledTools, enabled: b.enabledTools });
  for (const p of sources.pairs) {
    const k = key(p.agentId, p.targetId);
    const item = pairs.get(k) ?? { from: p.agentId, to: p.targetId, name: p.agentId === wiresId ? p.inspection?.targetName || p.targetId : p.inspection?.agentName || p.agentId, kind: 'agent', bound: p.bound, sources: [] };
    item.sources = p.sources.map((s) => `${CONNECTION_SOURCE_LABELS[s.kind]}${s.suspended ? ` (${s.suspended})` : ''}`);
    if (p.unresolved) item.sources.push('Source unresolved');
    pairs.set(k, item);
  }
  c.summary = remote.length ? `${pairs.size} local directions · ${remote.length} remote connections` : `${pairs.size} directions`;
  for (const p of pairs.values()) {
    const direction = directions.find((d) => !d.from.machineId && !d.to.machineId && d.from.agentId === p.from && d.to.agentId === p.to);
    const tools = localDirectionTools(direction, p.disabled, p.enabled);
    row(c, p.name, `${p.kind} · ${p.from === wiresId ? 'to' : 'from'} · ${p.bound ? 'connected' : 'saved, not connected'}${p.sources.length ? ` · ${p.sources.join(', ')}` : ''}`);
    if (p.kind === 'agent') row(c, `${p.name} permissions`, `Allowed: ${tools.allowed.join(', ') || 'none'}; Off: ${tools.disabled.join(', ') || 'none'}`);
  }
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  const machineName = (id: string) => getSatellite(id)?.alias || getPeer(id)?.alias || id;
  for (const remotePeer of remote) {
    const satellite = getSatellite(remotePeer.machine);
    const snapshot = satellite?.snapshot;
    const candidates = [...Object.values(snapshot?.agents ?? {}), ...Object.values(snapshot?.quickAgents ?? {})].flat().filter((agent) => record(agent) && agent.id === remotePeer.agentId);
    const dispatcher = snapshot?.dispatcher;
    if (record(dispatcher) && record(dispatcher.agent) && dispatcher.agent.id === remotePeer.agentId) candidates.push(dispatcher.agent);
    const name = candidates.length === 1 && record(candidates[0]) && typeof candidates[0].name === 'string' ? candidates[0].name : remotePeer.agentId;
    const peer = getPeer(remotePeer.machine);
    const availability = satellite?.needsPairing ? 'pairing required' : satellite?.state ?? 'connection state not retained';
    const historical = !snapshot || !satellite || satellite.state !== 'connected' || satellite.snapshotUnavailable || !!snapshot.snapshotTruncated?.omitted?.length;
    row(c, name, `on ${machineName(remotePeer.machine)} · ${remotePeer.direction === 'two-way' ? 'two-way' : remotePeer.direction === 'to' ? 'sends to it' : 'sends to this agent'} · saved network link · ${availability}${historical ? ' · names from retained metadata' : ' · names from cached snapshot'}`);
    row(c, `${name} address`, remotePeer.address);
    if (historical && peer?.lastSeen) row(c, `${name} last seen`, peer.lastSeen);
    const touching = directions.filter((d) => !d.from.machineId && d.from.agentId === wiresId && d.to.machineId === remotePeer.machine && d.to.agentId === remotePeer.agentId
      || !d.to.machineId && d.to.agentId === wiresId && d.from.machineId === remotePeer.machine && d.from.agentId === remotePeer.agentId);
    for (const direction of touching) {
      const outgoing = !direction.from.machineId;
      const on = CONNECTION_SWITCHES.filter((tool) => !direction.disabledTools.includes(tool.tool)).map((tool) => tool.label);
      const off = CONNECTION_SWITCHES.filter((tool) => direction.disabledTools.includes(tool.tool)).map((tool) => tool.label);
      const source = direction.link || direction.cardLink || activeAgentLinks(direction).length ? 'Saved switches' : 'Saved, no active source';
      row(c, `${name} ${outgoing ? 'outgoing' : 'incoming'} switches`, `${source} · Allowed: ${on.join(', ') || 'none'}; Off: ${off.join(', ') || 'none'}`);
      for (const maker of activeAgentLinks(direction)) row(c, `${name} link source`, `Made by ${maker.name || maker.agentId} on ${machineName(maker.machineId)}`);
    }
    if (candidates.length !== 1) c.notes.push(`The name for ${remotePeer.address} is unavailable or ambiguous in the retained host snapshot. Its saved address and directions are shown.`);
  }
  for (const source of sources.unreadable) c.notes.push(`Couldn’t read connection source: ${display(source)}`);
  if (sources.unreadable.length) {
    c.summary = `${pairs.size} known local directions · ${remote.length} remote connections · source data incomplete`;
    if (!pairs.size && !remote.length) c.state = 'error';
  } else if (!pairs.size && !remote.length) c.notes.push('No Clubhouse MCP wires.');
}

export function readActionCard(c: RemoteDetailsCard, agentId: string, projectId: string, dispatcher = false) {
  const names = { ...actionNames(), device: (id: string) => getSatellite(id)?.alias || getPeer(id)?.alias };
  const fields = readActionDetailsForAgent(agentId, projectId, dispatcher, names);
  c.summary = fields.summary; c.rows = fields.rows; c.notes.push(...fields.notes); c.omitted += fields.omitted;
}

export async function readCanvasCard(c: RemoteDetailsCard, agentId: string, projectId: string) {
  const hits = await getAgentCanvasMemberships(agentId, projectId, { strict: true });
  c.summary = `on ${hits.length} ${hits.length === 1 ? 'board' : 'boards'}`;
  for (const hit of hits) {
    const before = c.rows.length;
    row(c, hit.name, hit.scope === 'app' ? 'Home' : 'card');
    if (c.rows.length > before && hit.canvasId && hit.viewId && hit.canvasId.length <= 2048 && hit.viewId.length <= 2048) {
      c.rows[c.rows.length - 1].canvas = { scope: hit.scope, canvasId: hit.canvasId, viewId: hit.viewId };
    }
  }
  if (!hits.length) c.state = 'not-applicable';
}
