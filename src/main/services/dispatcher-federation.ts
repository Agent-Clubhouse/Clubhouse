/** Membership owns controller links. The pinned computer publishes its controller,
 * never its visible chat. Offline metadata is retained, but revocation wins on
 * every lookup, including attempts already waiting in durable delivery. */
import { formatAgentAddress } from '../../shared/agent-address';
import type { AgentAddress, ConnectionDirection } from '../../shared/connection-grants';
import { createSettingsStore } from './settings-store';
import { listPeers } from './annex-peers';
import { onDevicesChanged } from './annex-device-signal';
import { dispatcherDisplayName, getDispatcherAgentId, isDispatcherEnabled, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { FEDERATION_DISABLED_TOOLS, FEDERATION_SOURCE_ID, setFederationLookup, setFederationStatus } from './dispatcher-federation-policy';
import type { PersistedBindingSource } from './persisted-bindings';

export interface FederationController {
  agentId: string | null;
  name: string;
  enabled: boolean;
  pairingId?: string;
}
const controllers = createSettingsStore<{ controllers: Record<string, FederationController> }>(
  'dispatcher-federation.json', { controllers: {} }, undefined,
  { atomic: true, audit: { key: 'dispatcher_federation' } },
);
const listeners = new Set<() => void>();
export function localFederationController(): FederationController {
  return { agentId: getDispatcherAgentId(), name: dispatcherDisplayName('work'), enabled: isDispatcherEnabled() };
}
export function remoteFederationController(machine: string): FederationController | undefined {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  const saved = controllers.get().controllers[machine.toLowerCase()];
  return peer && saved?.pairingId === peer.pairingId ? saved : undefined;
}
export async function learnFederationController(machine: string, raw: unknown): Promise<void> {
  const peer = listPeers().find((p) => p.fingerprint.toLowerCase() === machine.toLowerCase() && p.role === 'member' && p.kind !== 'phone');
  if (!peer) return;
  const value = raw as FederationController | null;
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean'
    || typeof value.name !== 'string' || !value.name || value.name.length > 200
    || (value.agentId !== null && (typeof value.agentId !== 'string' || !value.agentId || value.agentId.length > 200 || value.agentId.includes('@')))) return;
  const info = { agentId: value.agentId, name: value.name, enabled: value.enabled, ...(peer.pairingId && { pairingId: peer.pairingId }) };
  if (JSON.stringify(remoteFederationController(machine)) === JSON.stringify(info)) return;
  await controllers.update((file) => {
    const members = new Set(listPeers().filter((p) => p.role === 'member' && p.kind !== 'phone').map((p) => p.fingerprint.toLowerCase()));
    return { controllers: { ...Object.fromEntries(Object.entries(file.controllers).filter(([id]) => members.has(id))), [machine.toLowerCase()]: info } };
  });
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
