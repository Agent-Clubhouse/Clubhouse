/**
 * The Annex device list (#3057): every paired device, whichever way it's
 * paired, with where it stands. Settings is built from this one list. The
 * single Annex Network page that shows it comes later (#3067).
 *
 * Built on demand from three sources that already exist:
 * - `annex-peers.json` (and the server's session-only phones): who is paired;
 * - the client's satellite connections: devices this machine connects to;
 * - the server's open sockets: devices connected to this machine.
 */
import type { AnnexDevice, AnnexDeviceState, AnnexPeer } from '../../shared/types';
import { describeAnnexProblem, type AnnexProblem } from '../../shared/annex-problems';
import * as annexPeers from './annex-peers';
import * as annexClient from './annex-client';
import * as annexServer from './annex-server';
import * as annexSettings from './annex-settings';
import * as membership from './annex-network-membership';

interface Sources {
  peers: AnnexPeer[];
  sessionPeers: AnnexPeer[];
  satellites: annexClient.SatelliteConnection[];
  connected: ReadonlySet<string>;
  /** Whether this machine connects to its satellites ("Connect to satellites"). */
  clientOn: boolean;
  /** Where this machine is reaching a satellite, as `host:port`. */
  addressOf: (fingerprint: string) => string | undefined;
  /** Where a member's join is confirmed, while it isn't everywhere yet (#3061). */
  joinOf?: (fingerprint: string) => membership.NetworkConfirmation | null;
  /** Removals some members haven't heard of yet. */
  removals?: membership.NetworkConfirmation[];
}

function readSources(): Sources {
  return {
    peers: annexPeers.listPeers(),
    sessionPeers: annexServer.sessionOnlyPeers(),
    satellites: annexClient.getSatellites(),
    connected: annexServer.connectedPeerFingerprints(),
    clientOn: annexSettings.getSettings().enableClient,
    addressOf: annexClient.satelliteAddress,
    joinOf: membership.joinConfirmation,
    removals: membership.pendingRemovals(),
  };
}

function satelliteState(sat: annexClient.SatelliteConnection | undefined): AnnexDeviceState {
  if (!sat) return 'offline';
  if (sat.needsPairing) return 'needs-pairing';
  switch (sat.state) {
    case 'connected': return 'connected';
    case 'connecting':
    case 'discovering': return 'connecting';
    default: return 'offline';
  }
}

function problemFor(peer: AnnexPeer, state: AnnexDeviceState, sat: annexClient.SatelliteConnection | undefined): AnnexProblem | null {
  if (state === 'connected') return null;
  if (sat?.problem) return sat.problem;
  if (state === 'needs-pairing') return describeAnnexProblem('old-pairing', peer.alias);
  // A satellite this machine hasn't found since it started: say so, rather than nothing.
  if (annexPeers.controlledFromHere(peer) && (!sat || (sat.state === 'discovering' && !sat.host))) {
    return describeAnnexProblem('not-found-yet', peer.alias);
  }
  return null;
}

/** The device list from given sources. Exported for tests. */
export function buildDeviceList(sources: Sources): AnnexDevice[] {
  const satellites = new Map(sources.satellites.map((s) => [s.fingerprint, s]));
  const seen = new Set<string>();
  const devices: AnnexDevice[] = [];

  const add = (peer: AnnexPeer, sessionOnly: boolean): void => {
    if (seen.has(peer.fingerprint)) return;
    seen.add(peer.fingerprint);
    const sat = annexPeers.controlledFromHere(peer) ? satellites.get(peer.fingerprint) : undefined;
    let state: AnnexDeviceState;
    let problem: AnnexProblem | null = null;
    if (annexPeers.peerNeedsPairing(peer)) state = 'needs-pairing';
    // A member connected either way is connected (#3061).
    else if (peer.role === 'member' && sources.connected.has(peer.fingerprint)) state = 'connected';
    else if (annexPeers.controlledFromHere(peer) && !sources.clientOn) {
      // Not this satellite's doing: this machine isn't connecting to any.
      state = 'offline';
      problem = describeAnnexProblem('client-off', peer.alias);
    } else if (annexPeers.controlledFromHere(peer)) state = satelliteState(sat);
    else state = sources.connected.has(peer.fingerprint) ? 'connected' : 'offline';
    devices.push({
      fingerprint: peer.fingerprint,
      alias: peer.alias || '',
      icon: peer.icon || 'computer',
      color: peer.color || 'indigo',
      role: peer.role ?? null,
      state,
      pairedAt: peer.pairedAt || '',
      lastSeen: peer.lastSeen || '',
      ...(sessionOnly && { sessionOnly: true }),
      ...(annexPeers.controlledFromHere(peer) && sat && sources.addressOf(peer.fingerprint) && { address: sources.addressOf(peer.fingerprint) }),
      ...(peer.typedHost && { typedHost: peer.typedHost }),
      problem: problem ?? problemFor(peer, state, sat),
      ...(joinConfirmation(peer) && { confirmation: joinConfirmation(peer)! }),
    });
  };
  const nameOf = (fp: string): string => sources.peers.find((p) => p.fingerprint.toLowerCase() === fp.toLowerCase())?.alias || fp;
  const joinConfirmation = (peer: AnnexPeer): AnnexDevice['confirmation'] | undefined => {
    if (peer.role !== 'member') return undefined;
    const c = sources.joinOf?.(peer.fingerprint);
    return c && c.waitingOn.length > 0
      ? { kind: 'join', confirmedBy: c.confirmedBy.map(nameOf), waitingOn: c.waitingOn.map(nameOf) }
      : undefined;
  };

  // Session-only phones first: the server holds the live record for them.
  for (const peer of sources.sessionPeers) add(peer, true);
  for (const peer of sources.peers) add(peer, false);

  // Removed members some others haven't heard about yet: listed until they have.
  for (const r of sources.removals ?? []) {
    if (seen.has(r.fingerprint)) continue;
    seen.add(r.fingerprint);
    devices.push({
      fingerprint: r.fingerprint,
      alias: r.name || '',
      icon: 'computer',
      color: 'indigo',
      role: 'member',
      state: 'removing',
      pairedAt: '',
      lastSeen: '',
      problem: null,
      confirmation: { kind: 'removal', confirmedBy: r.confirmedBy.map(nameOf), waitingOn: r.waitingOn.map(nameOf) },
    });
  }

  return devices.sort((a, b) => a.alias.localeCompare(b.alias) || a.fingerprint.localeCompare(b.fingerprint));
}

export function listDevices(): AnnexDevice[] {
  return buildDeviceList(readSources());
}

/**
 * Removes a device, whichever way it's paired, and ends its connections at
 * once: this machine's connection to it, and any it has to this machine.
 * Returns whether anything was removed.
 */
export function removeDevice(fingerprint: string): boolean {
  const peer = annexPeers.getPeer(fingerprint);
  // A network member is removed everywhere: every member hears before its connections are cut (#3061).
  if (peer?.role === 'member') membership.noteLocalRemoval(fingerprint);
  // This machine's own connection to it, if it's (or was found as) a satellite here.
  const wasSatellite = annexPeers.controlledFromHere(peer) || annexClient.getSatellite(fingerprint) !== null;
  if (wasSatellite) annexClient.forgetSatellite(fingerprint);
  // Its entry, if still there, then any socket it has to this machine: cut, not left to close.
  const revoked = annexServer.revokePeer(fingerprint);
  return wasSatellite || revoked;
}
