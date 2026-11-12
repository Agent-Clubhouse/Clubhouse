import { dispatcherFederationPeers, isDispatcherFederationIdentity, type DispatcherFederationMember } from '../../../shared/dispatcher-federation';
import { getIdentity } from '../annex-identity';
import { getSatellites } from '../annex-client';
import { listPeers } from '../annex-peers';
import { onDevicesChanged } from '../annex-device-signal';
import { getDispatcherState, onDispatcherChanged } from './dispatcher-service';
import { setDispatcherFederationControllerId, setDispatcherFederationPeers } from './dispatcher-federation-presence';
import {
  dispatcherFederationTrips, knownDispatcherFederationController, onDispatcherFederationPeerStateChanged, rememberDispatcherFederationControllers,
} from './dispatcher-federation-peer-state';

export function dispatcherFederationMembers(): DispatcherFederationMember[] {
  const satellites = getSatellites();
  const members = listPeers().filter((peer) => peer.role === 'member' && peer.kind === 'desktop');
  rememberDispatcherFederationControllers(members.map((peer) => {
    const satellite = satellites.find((sat) => sat.fingerprint.toLowerCase() === peer.fingerprint.toLowerCase());
    const candidate = satellite?.snapshot?.dispatcherFederation;
    return { machineId: peer.fingerprint, ...(isDispatcherFederationIdentity(candidate) && !satellite?.snapshotUnavailable && { identity: candidate }) };
  }));
  return members.flatMap((peer): DispatcherFederationMember[] => {
    const satellite = satellites.find((sat) => sat.fingerprint.toLowerCase() === peer.fingerprint.toLowerCase());
    const identity = satellite?.snapshot?.dispatcherFederation;
    return [{
      machineId: peer.fingerprint, machineName: peer.alias, role: peer.role, kind: peer.kind,
      connected: satellite?.state === 'connected', lastSeen: peer.lastSeen,
      controller: knownDispatcherFederationController(peer.fingerprint),
      ...(isDispatcherFederationIdentity(identity) && !satellite?.snapshotUnavailable && { dispatcher: identity }),
    }];
  });
}

export function refreshDispatcherFederationPresence(): void {
  const self = getIdentity()?.fingerprint;
  const state = getDispatcherState();
  setDispatcherFederationControllerId(state.agentId);
  setDispatcherFederationPeers(self ? dispatcherFederationPeers(self, state.enabled, dispatcherFederationMembers(), dispatcherFederationTrips()) : []);
}

/** Reuses membership/snapshot/connectivity notifications, including offline joins and removals. */
export function watchDispatcherFederationPresence(): () => void {
  const offDevices = onDevicesChanged(refreshDispatcherFederationPresence);
  const offDispatcher = onDispatcherChanged(refreshDispatcherFederationPresence);
  const offPeerState = onDispatcherFederationPeerStateChanged(refreshDispatcherFederationPresence);
  refreshDispatcherFederationPresence();
  return () => { offDevices(); offDispatcher(); offPeerState(); setDispatcherFederationControllerId(null); setDispatcherFederationPeers([]); };
}
