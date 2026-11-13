/** The person's Connections-card sources and the network directory last seen from each peer. */
import type { AddCardConnection, ConnectionPickerDirectory, ConnectionPickerTarget } from '../../shared/connection-picker';
import { CONNECTION_SWITCHES, localToolsFromAllow } from '../../shared/connection-grants';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { formatAgentAddress, isMachineFingerprint } from '../../shared/agent-address';
import { createSettingsStore } from './settings-store';
import * as projectStore from './project-store';
import * as agentConfig from './agent-config';
import { agentRegistry } from './agent-registry';
import { mcpCallerKind } from './clubhouse-mcp/mcp-call-gate';
import * as annexPeers from './annex-peers';
import * as annexIdentity from './annex-identity';
import { rememberRemoteAgentName } from './annex-agent-calls';
import { groupProjectRegistry } from './group-project-registry';
import { withoutManagedMembers } from './managed-group-projects';
import { addMember as addGroupMember, excludeMember as excludeGroupMember, isMembershipManaged } from './group-project-membership';
import { bindingManager } from './clubhouse-mcp/binding-manager';
import { getConnectionDirection, linkCardDirections, listAllConnectionDirections, removeCardDirection } from './connection-grants-store';
import { bindingTargetOf, connectionEnd } from './connection-grants';
import { claimSourceBinding, clearBindingRemovedByUser, collectSourcesByPair, onBindingRemovedByUser, registerPersistedBindingSource, rebuildPersistedBindings, type PersistedBinding, type PersistedBindingSource } from './persisted-bindings';

export const CARD_CONNECTION_SOURCE_ID = 'connections-card';
interface Membership { agentId: string; groupId: string }
interface PeerInventory { pairingId?: string; targets: ConnectionPickerTarget[] }
interface CardFile { version: number; memberships: Membership[]; peers: Record<string, PeerInventory> }
const store = createSettingsStore<CardFile>('connection-card.json', { version: 1, memberships: [], peers: {} }, undefined,
  { atomic: true, rollBackFailedSaves: true, audit: { key: 'connection_card', ignore: ['peers'] } });

/** Save just agent and project names from an authenticated, complete network snapshot. */
export async function rememberConnectionSnapshot(machine: string, snapshot: unknown): Promise<void> {
  const peer = annexPeers.listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  if (!peer || !snapshot || typeof snapshot !== 'object') return;
  const raw = snapshot as { projects?: unknown; agents?: unknown; dispatcher?: unknown; snapshotTruncated?: { omitted?: string[] } };
  if (!Array.isArray(raw.projects) || !raw.agents || typeof raw.agents !== 'object' || raw.snapshotTruncated?.omitted?.some((s) => s === 'projects' || s === 'agents')) return;
  const agents = raw.agents as Record<string, unknown>;
  const targets: ConnectionPickerTarget[] = [];
  for (const value of raw.projects.slice(0, 1000)) {
    if (!value || typeof value !== 'object') continue;
    const project = value as { id?: unknown; name?: unknown; displayName?: unknown };
    if (typeof project.id !== 'string' || typeof project.name !== 'string' || !Array.isArray(agents[project.id])) continue;
    for (const item of (agents[project.id] as unknown[]).slice(0, 5000)) {
      if (!item || typeof item !== 'object') continue;
      const agent = item as { id?: unknown; name?: unknown; kind?: unknown };
      if (typeof agent.id !== 'string' || !agent.id || agent.id.length > 200 || agent.id.includes('@') || typeof agent.name !== 'string' || !agent.name || agent.name.length > 200 || (agent.kind && agent.kind !== 'durable')) continue;
      targets.push({ id: agent.id, name: agent.name, kind: 'agent', project: typeof project.displayName === 'string' && project.displayName ? project.displayName : project.name });
    }
  }
  const dispatcher = raw.dispatcher as { agent?: { id?: unknown; name?: unknown } } | undefined;
  if (typeof dispatcher?.agent?.id === 'string' && typeof dispatcher.agent.name === 'string' && dispatcher.agent.id.length <= 200 && !dispatcher.agent.id.includes('@')) {
    targets.push({ id: dispatcher.agent.id, name: dispatcher.agent.name, kind: 'dispatcher' });
  }
  if (targets.length > 5000) return;
  const id = machine.toLowerCase();
  await store.update((file) => {
    if (file.version > 1) throw new Error('The saved connection directory was written by a newer Clubhouse.');
    return { ...file, peers: { ...file.peers, [id]: { ...(peer.pairingId && { pairingId: peer.pairingId }), targets } } };
  });
}

async function localAgents(): Promise<ConnectionPickerTarget[]> {
  const projects = await projectStore.list();
  const groups = await Promise.all(projects.map(async (project) => (await agentConfig.listDurable(project.path)).filter((a) => !isDisposedAgent(a)).map((agent): ConnectionPickerTarget => ({ id: agent.id, name: agent.name, kind: 'agent', project: project.displayName || project.name }))));
  const dispatcher = await import('./dispatcher/dispatcher-service').then((m) => m.getDispatcherState());
  return [...groups.flat(), ...(dispatcher.config ? [{ id: dispatcher.config.id, name: dispatcher.config.name, kind: 'dispatcher' as const }] : [])];
}

/** Quick agents may start a connection while alive, but are not picker targets. */
async function sourceAgents(): Promise<ConnectionPickerTarget[]> {
  const durable = await localAgents();
  const known = new Set(durable.map((agent) => agent.id));
  const quick = [...agentRegistry.getAllRegistrations().keys()].filter((id) => mcpCallerKind(id) === 'quick' && !known.has(id))
    .map((id): ConnectionPickerTarget => ({ id, name: id, kind: 'agent' }));
  return [...durable, ...quick];
}

export async function listConnectionPickerTargets(agentId: string): Promise<ConnectionPickerDirectory> {
  const [locals, groups, client] = await Promise.all([localAgents(), groupProjectRegistry.list(), import('./annex-client')]);
  const saved = store.get();
  if (saved.version > 1) throw new Error('The saved connection directory was written by a newer Clubhouse.');
  const peers = annexPeers.listPeers();
  const remote = peers.filter((p) => p.role === 'member' && p.kind !== 'phone').flatMap((peer) => {
    const machineId = peer.fingerprint.toLowerCase();
    const inventory = saved.peers?.[machineId];
    if (!inventory || inventory.pairingId !== peer.pairingId || !Array.isArray(inventory.targets)) return [];
    return inventory.targets.map((target) => ({ ...target, machineId, machineName: peer.alias, online: client.isMachineConnected(machineId) }));
  });
  return { targets: [...locals.filter((target) => target.id !== agentId), ...remote, ...groups.map((group): ConnectionPickerTarget => ({ id: group.id, name: group.name, kind: 'group-project' }))],
    machines: peers.map((peer) => ({ id: peer.fingerprint.toLowerCase(), name: peer.alias, network: peer.role === 'member' && peer.kind !== 'phone' })),
    ...(annexIdentity.getIdentity()?.fingerprint && { selfMachineId: annexIdentity.getIdentity()!.fingerprint.toLowerCase() }), };
}

/** Bindings saved independently of canvases. */
export const cardConnectionSource: PersistedBindingSource = {
  id: CARD_CONNECTION_SOURCE_ID,
  prune: true,
  async collect() {
    const [locals, groups] = await Promise.all([sourceAgents(), groupProjectRegistry.list()]);
    const names = new Map(locals.map((a) => [a.id, a.name]));
    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    const memberships = (store.get().memberships ?? []).filter((m) => names.has(m.agentId) && groupNames.has(m.groupId)).map((m): PersistedBinding => ({
      agentId: m.agentId, targetId: m.groupId, targetKind: 'group-project', label: groupNames.get(m.groupId)!, agentName: names.get(m.agentId), targetName: groupNames.get(m.groupId),
    }));
    const directions = listAllConnectionDirections().filter((d) => d.cardLink && !d.from.machineId && names.has(d.from.agentId) && (d.to.machineId || names.has(d.to.agentId)));
    const peers = store.get().peers ?? {};
    // A group project whose members are a record (#3357) isn't held here.
    return [...await withoutManagedMembers(memberships), ...directions.map((d): PersistedBinding => {
      const targetId = bindingTargetOf(d.to);
      const name = d.to.machineId ? peers[d.to.machineId]?.targets.find((a) => a.id === d.to.agentId)?.name ?? d.to.agentId : names.get(d.to.agentId)!;
      return { agentId: d.from.agentId, targetId, targetKind: 'agent', label: name, agentName: names.get(d.from.agentId), targetName: name, disabledTools: d.disabledTools };
    })];
  },
};

const quickCallers = new Set<string>();

export function startCardConnections(): () => void {
  const unregister = registerPersistedBindingSource(cardConnectionSource);
  const unwatch = onBindingRemovedByUser((agentId, targetId) => {
    void removeCardConnection(agentId, targetId).catch(() => { /* telemetry-exempt: the user removal remains in effect for this session */ });
  });
  const unwatchQuick = agentRegistry.onAuthChange((id) => {
    if (agentRegistry.get(id) || !quickCallers.delete(id)) return;
    void (async () => {
      for (const direction of listAllConnectionDirections()) {
        if (direction.cardLink && ((!direction.from.machineId && direction.from.agentId === id) || (!direction.to.machineId && direction.to.agentId === id))) {
          await removeCardDirection(direction.from, direction.to);
        }
      }
      await store.update((file) => ({ ...file, memberships: file.memberships.filter((membership) => membership.agentId !== id) }));
      await rebuildPersistedBindings();
    })().catch(() => { /* telemetry-exempt: the dead quick agent is not restored */ });
  });
  return () => { unwatchQuick(); unwatch(); unregister(); };
}

function checkedAllow(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((tool) => typeof tool !== 'string' || !CONNECTION_SWITCHES.some((switch_) => switch_.tool === tool))) throw new Error('Choose valid connection switches.');
  return [...new Set(value as string[])];
}

export async function addCardConnection(request: AddCardConnection): Promise<void> {
  if (!request || typeof request.agentId !== 'string' || typeof request.targetId !== 'string' || typeof request.twoWay !== 'boolean') throw new Error('That connection is invalid.');
  const locals = await sourceAgents();
  const caller = locals.find((agent) => agent.id === request.agentId);
  if (!caller) throw new Error('The starting agent is not available on this computer.');
  if (mcpCallerKind(caller.id) === 'quick') quickCallers.add(caller.id);
  const { targets } = await listConnectionPickerTargets(request.agentId);
  const target = targets.find((candidate) => candidate.id === request.targetId && candidate.kind === request.targetKind && candidate.machineId === request.machineId);
  if (!target) throw new Error(request.machineId ? 'That agent or computer is not in the saved Annex Network directory.' : 'That target is no longer available.');
  const targetId = target.machineId ? formatAgentAddress({ agentId: target.id, machine: target.machineId }) : target.id;
  const { bySource, failed } = await collectSourcesByPair();
  if (failed.length) throw new Error('Connection sources could not be checked. Try again.');
  const keys = [`${caller.id}\u0000${targetId}`, `${targetId}\u0000${caller.id}`];
  if ([...bySource.values()].some((pairs) => keys.some((key) => pairs.has(key))) || bindingManager.getAllBindings().some((b) => keys.includes(`${b.agentId}\u0000${b.targetId}`))) throw new Error('These targets are already connected.');
  let removedDuringSave = false;
  const unwatch = onBindingRemovedByUser((from, to) => {
    if ((from === caller.id && to === targetId) || (request.twoWay && from === targetId && to === caller.id)) removedDuringSave = true;
  });
  try {
  if (target.kind === 'group-project' && await isMembershipManaged(target.id)) {
    // Its members are a record (#3357): joining adds the agent there. No member leads by joining (#3360).
    await addGroupMember(target.id, caller.id);
  } else if (target.kind === 'group-project') {
    await store.update((file) => {
      if (file.version > 1) throw new Error('The saved connections were written by a newer Clubhouse.');
      if (file.memberships.some((m) => m.agentId === caller.id && m.groupId === target.id)) throw new Error('This agent is already a member.');
      return { ...file, memberships: [...file.memberships, { agentId: caller.id, groupId: target.id }] };
    });
    if (removedDuringSave) { await removeCardConnection(caller.id, target.id); throw new Error('A newer removal canceled this connection.'); }
    clearBindingRemovedByUser(caller.id, target.id);
    claimSourceBinding(CARD_CONNECTION_SOURCE_ID, { agentId: caller.id, targetId: target.id, targetKind: 'group-project', label: target.name, agentName: caller.name, targetName: target.name });
  } else {
    if (target.machineId && !isMachineFingerprint(target.machineId)) throw new Error('That machine address is invalid.');
    const self = annexIdentity.getIdentity()?.fingerprint?.toLowerCase();
    if (target.machineId && target.machineId === self) throw new Error('That agent is on this computer.');
    if (target.machineId) await rememberRemoteAgentName(targetId, target.name);
    const from = { agentId: caller.id };
    const to = { agentId: target.id, ...(target.machineId && { machineId: target.machineId }) };
    const convert = (allow: string[]) => {
      const selected = checkedAllow(allow);
      const local = localToolsFromAllow(selected);
      return target.machineId ? { disabledTools: CONNECTION_SWITCHES.filter((s) => !selected.includes(s.tool)).map((s) => s.tool), enabledTools: [] } : local;
    };
    await linkCardDirections([{ from, to, ...convert(request.allow) }, ...(request.twoWay ? [{ from: to, to: from, ...convert(request.allowBack) }] : [])]);
    if (removedDuringSave) {
      await removeCardDirection(from, to);
      if (request.twoWay) await removeCardDirection(to, from);
      throw new Error('A newer removal canceled this connection.');
    }
    clearBindingRemovedByUser(caller.id, targetId);
    if (request.twoWay) clearBindingRemovedByUser(targetId, caller.id);
  }
  await rebuildPersistedBindings();
  } finally { unwatch(); }
}

export async function removeCardConnection(agentId: string, targetId: string): Promise<void> {
  const from = connectionEnd(agentId);
  const remote = connectionEnd(targetId);
  if (getConnectionDirection(from, remote)?.cardLink) await removeCardDirection(from, remote);
  else {
    await store.update((file) => ({ ...file, memberships: file.memberships.filter((m) => m.agentId !== agentId || m.groupId !== targetId) }));
    // A record-managed group project (#3357): removing the membership excludes the agent there.
    if ((await groupProjectRegistry.list()).some((g) => g.id === targetId) && await isMembershipManaged(targetId)) await excludeGroupMember(targetId, agentId);
  }
  await rebuildPersistedBindings();
}
