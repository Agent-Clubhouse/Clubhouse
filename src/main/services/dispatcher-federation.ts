/** Membership owns controller links. The pinned computer publishes its controller,
 * never its visible chat. Offline metadata is retained, but revocation wins on
 * every lookup, including attempts already waiting in durable delivery. */
import { formatAgentAddress } from '../../shared/agent-address';
import type { AgentAddress, ConnectionDirection } from '../../shared/connection-grants';
import { createSettingsStore } from './settings-store';
import { ownPairing } from './annex-network-membership';
import { listPeers } from './annex-peers';
import { onDevicesChanged } from './annex-device-signal';
import { dispatcherDisplayName, getDispatcherAgentId, getDispatcherState, isDispatcherEnabled, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { isPublishedDispatcherState, type PublishedDispatcherState } from '../../shared/dispatcher-presence';
import { FEDERATION_DISABLED_TOOLS, FEDERATION_SOURCE_ID, setFederationLookup, setFederationStatus, type FederationPublicationGuard } from './dispatcher-federation-policy';
import type { PersistedBindingSource } from './persisted-bindings';

export interface FederationController {
  agentId: string | null;
  name: string;
  enabled: boolean;
  /** Whether it is working or asleep, for presence (#3349). Older computers don't send it. */
  state?: PublishedDispatcherState;
  pairingId?: string;
  ownPairingId?: string;
}
const controllers = createSettingsStore<{ controllers: Record<string, FederationController> }>(
  'dispatcher-federation.json', { controllers: {} }, undefined,
  { atomic: true, audit: { key: 'dispatcher_federation' } },
);
const listeners = new Set<() => void>();
export function localFederationController(): FederationController {
  const enabled = isDispatcherEnabled();
  return { agentId: getDispatcherAgentId(), name: dispatcherDisplayName('work'), enabled, ...(enabled && { state: localDispatcherState() }) };
}

/** As the Dispatcher's own badge judges it: asleep while its agent isn't running, working while requests are under way. */
function localDispatcherState(): PublishedDispatcherState {
  const state = getDispatcherState();
  if (!state.workRunning) return 'asleep';
  return state.requestsUnderWay > 0 ? 'working' : 'online';
}

/** Hear when a computer's published controller changes. */
export function onFederationControllersChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function remoteFederationController(machine: string): FederationController | undefined {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  const saved = controllers.get().controllers[machine.toLowerCase()];
  return peer && saved && saved.pairingId === peer.pairingId && (saved.ownPairingId ?? 'legacy') === (ownPairing()?.id ?? 'legacy') ? saved : undefined;
}
export async function learnFederationController(machine: string, raw: unknown, publication?: FederationPublicationGuard): Promise<void> {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  if (!peer) return;
  const pairing = publication?.epoch.receiver ?? peer.pairingId ?? 'legacy';
  const selfPairing = publication?.epoch.sender ?? ownPairing()?.id ?? 'legacy';
  const current = () => (!publication || publication.current()) && (ownPairing()?.id ?? 'legacy') === selfPairing && listPeers().some((p) => p.fingerprint.toLowerCase() === machine.toLowerCase()
    && p.role === 'member' && p.kind !== 'phone' && (p.pairingId ?? 'legacy') === pairing);
  if (!current()) return;
  const value = raw as FederationController | null;
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean'
    || typeof value.name !== 'string' || !value.name || value.name.length > 200
    || (value.agentId !== null && (typeof value.agentId !== 'string' || !value.agentId || value.agentId.length > 200 || value.agentId.includes('@')))
    || (value.state !== undefined && !isPublishedDispatcherState(value.state))) return;
  const info = { agentId: value.agentId, name: value.name, enabled: value.enabled, ...(value.state && { state: value.state }),
    ownPairingId: selfPairing, ...(peer.pairingId && { pairingId: peer.pairingId }) };
  if (JSON.stringify(remoteFederationController(machine)) === JSON.stringify(info)) return;
  const stale = new Error('Controller publication belongs to an earlier network pairing or service.');
  try {
    await controllers.update((file) => {
      const members = new Set(listPeers().filter((p) => p.role === 'member' && p.kind !== 'phone').map((p) => p.fingerprint.toLowerCase()));
      return { controllers: { ...Object.fromEntries(Object.entries(file.controllers).filter(([id]) => members.has(id))), [machine.toLowerCase()]: info } };
    }, { prepare: async () => {}, check: () => { if (!current()) throw stale; } });
  } catch (err) {
    if (err === stale) return;
    throw err;
  }
  if (!current()) return;
  for (const listener of listeners) listener();
}

/** The receiving computer's own copy, derived from its own membership. */
export function controllerDirection(from: AgentAddress, to: AgentAddress): ConnectionDirection | undefined {
  if (!!from.machineId === !!to.machineId) return undefined;
  const remote = from.machineId ? from : to;
  const local = from.machineId ? to : from;
  if (local.agentId !== getDispatcherAgentId()) return undefined;
  const machine = remote.machineId!.toLowerCase();
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine && p.role === 'member' && p.kind !== 'phone');
  if (!peer) return undefined;
  if (remoteFederationController(machine)?.agentId !== remote.agentId) return undefined;
  const joinedAt = peer.pairedAt || new Date(0).toISOString();
  return { from, to, disabledTools: [...FEDERATION_DISABLED_TOOLS], link: { createdAt: joinedAt }, updatedAt: joinedAt };
}

export const federationBindingSource: PersistedBindingSource = {
  id: FEDERATION_SOURCE_ID, prune: true, readOnlyCollect: true,
  async collect() {
    const local = localFederationController();
    if (!local.agentId || !local.enabled) return [];
    return listPeers().flatMap((peer) => {
      if (peer.role !== 'member' || peer.kind === 'phone') return [];
      const remote = remoteFederationController(peer.fingerprint);
      if (!remote?.agentId) return [];
      const address = formatAgentAddress({ agentId: remote.agentId, machine: peer.fingerprint.toLowerCase() });
      return [{ agentId: local.agentId!, targetId: address,
        targetKind: 'agent' as const, label: `${remote.name} on ${peer.alias}`, agentName: local.name,
        targetName: remote.name, projectName: peer.alias, disabledTools: [...FEDERATION_DISABLED_TOOLS], enabledTools: [] as string[], startingTools: true as const }, {
          agentId: address, targetId: local.agentId!, targetKind: 'agent' as const,
          label: local.name, agentName: remote.name, targetName: local.name, projectName: peer.alias,
          disabledTools: [...FEDERATION_DISABLED_TOOLS], enabledTools: [] as string[], startingTools: true as const,
        }];
    });
  },
};

export function watchFederation(changed: () => void, connected: (machine: string) => boolean = () => true): () => void {
  const offLookup = setFederationLookup(controllerDirection);
  const offStatus = setFederationStatus((from, to) => {
    if (!controllerDirection(from, to)) return undefined;
    const remote = from.machineId ? from : to;
    if (!isDispatcherEnabled()) return { state: 'unavailable', reason: 'This Dispatcher is off. Controller links are unavailable.' };
    if (!remoteFederationController(remote.machineId!)?.enabled) return { state: 'unavailable', reason: 'The other Dispatcher is off. Controller links are unavailable.' };
    if (!connected(remote.machineId!)) return { state: 'paused', reason: 'The other computer is offline. Controller links are paused until it reconnects.' };
    return undefined;
  });
  listeners.add(changed);
  const offDevices = onDevicesChanged(changed);
  const offDispatcher = onDispatcherChanged(changed);
  return () => { offLookup(); offStatus(); listeners.delete(changed); offDevices(); offDispatcher(); };
}
