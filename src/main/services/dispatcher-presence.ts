/**
 * The Dispatchers on this person's other computers (#3349), as one read-only
 * snapshot for Settings, Details, the controller, the phone and pickers
 * (#3348). Built from what the controller links already know: each member's
 * published controller (#3345), the link status, and Annex Network presence
 * (peer alias and last seen, live connectivity). It reads nothing new from
 * other computers and polls nothing; it recomputes when those sources change.
 */
import { formatAgentAddress } from '../../shared/agent-address';
import { remoteDispatcherLabel, type DispatcherPresenceSnapshot, type RemoteDispatcherPresence } from '../../shared/dispatcher-presence';
import { listPeers } from './annex-peers';
import { onDevicesChanged } from './annex-device-signal';
import { getDispatcherAgentId, isDispatcherEnabled, onDispatcherChanged } from './dispatcher/dispatcher-service';
import { onFederationControllersChanged, remoteFederationController } from './dispatcher-federation';
import { federationStatus, onFederationStatusChanged } from './dispatcher-federation-policy';

type Connected = (machine: string) => boolean;
type LastConfirmed = (machine: string) => string | undefined;

let connected: Connected = () => false;
let lastConfirmed: LastConfirmed = () => undefined;
let last = '';
const listeners = new Set<() => void>();

function presenceFor(peer: ReturnType<typeof listPeers>[number]): RemoteDispatcherPresence {
  const machineId = peer.fingerprint.toLowerCase();
  const machineName = peer.alias || machineId;
  const controller = remoteFederationController(machineId);
  const isConnected = connected(machineId);
  const address = controller?.agentId ? formatAgentAddress({ agentId: controller.agentId, machine: machineId }) : null;
  const dispatcherName = controller?.name ?? null;
  const state: RemoteDispatcherPresence['state'] = !isConnected ? 'offline'
    : !controller ? 'unknown'
      : !controller.enabled ? 'off'
        : controller.state ?? 'online';
  const localId = getDispatcherAgentId();
  let link: RemoteDispatcherPresence['link'];
  if (!localId || !isDispatcherEnabled()) link = { state: 'unavailable', reason: 'This Dispatcher is off. Controller links are unavailable.' };
  else if (!controller?.agentId) link = isConnected
    ? { state: 'unavailable', reason: 'That computer hasn\'t shared its Dispatcher yet.' }
    : { state: 'paused', reason: 'The other computer is offline. Controller links are paused until it reconnects.' };
  else {
    const status = federationStatus({ agentId: localId }, { agentId: controller.agentId, machineId });
    link = status ? { state: status.state, reason: status.reason } : { state: 'active' };
  }
  return {
    machineId, machineName, address, dispatcherName,
    label: remoteDispatcherLabel(dispatcherName, machineName),
    state,
    ...(state === 'offline' && lastSeenOf(machineId, peer.lastSeen)),
    link,
  };
}

/** The later of the stored last seen and this run's last confirmed connectivity, so a long connection reads right. */
function lastSeenOf(machineId: string, stored: string | undefined): { lastSeen?: string } {
  const live = lastConfirmed(machineId);
  const candidates = [stored, live].filter((v): v is string => !!v && Number.isFinite(Date.parse(v)));
  if (candidates.length === 0) return {};
  return { lastSeen: candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) };
}

/** Every other computer member's Dispatcher, now. Never phones. */
export function getDispatcherPresence(): DispatcherPresenceSnapshot {
  const remotes = listPeers()
    .filter((peer) => peer.role === 'member' && peer.kind !== 'phone')
    .map(presenceFor)
    .sort((a, b) => a.machineName.localeCompare(b.machineName) || a.machineId.localeCompare(b.machineId));
  return { remotes };
}

/** "<Dispatcher name> on <machine>" for a remote-originated item, or undefined for a computer this one doesn't know. */
export function remoteDispatcherLabelFor(machineId: string): string | undefined {
  return getDispatcherPresence().remotes.find((r) => r.machineId === machineId.toLowerCase())?.label;
}

/** Hear when the snapshot changes. Fires only for a real change. */
export function onDispatcherPresenceChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function recompute(): void {
  const next = JSON.stringify(getDispatcherPresence());
  if (next === last) return;
  last = next;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
  }
}

/**
 * Start following the sources. `isConnected` and `lastConfirmedAt` are the
 * Annex client's live connectivity and last confirmed contact, passed in so
 * this module stays free of the client's imports.
 */
export function watchDispatcherPresence(isConnected: Connected, lastConfirmedAt: LastConfirmed = () => undefined): () => void {
  connected = isConnected;
  lastConfirmed = lastConfirmedAt;
  last = JSON.stringify(getDispatcherPresence());
  const offs = [onDevicesChanged(recompute), onDispatcherChanged(recompute), onFederationControllersChanged(recompute), onFederationStatusChanged(recompute)];
  return () => {
    for (const off of offs) off();
    connected = () => false;
    lastConfirmed = () => undefined;
  };
}

/** Test helper. */
export function _resetDispatcherPresenceForTesting(): void {
  listeners.clear();
  connected = () => false;
  lastConfirmed = () => undefined;
  last = '';
}
