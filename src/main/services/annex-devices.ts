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
import type { AnnexDevice, AnnexDeviceReach, AnnexDeviceState, AnnexDirection, AnnexPeer } from '../../shared/types';
import { describeAnnexProblem, isAnnexLoopback, type AnnexProblem } from '../../shared/annex-problems';
import * as annexPeers from './annex-peers';
import * as annexClient from './annex-client';
import * as annexServer from './annex-server';
import * as annexSettings from './annex-settings';
import * as membership from './annex-network-membership';
import * as networkChannel from './annex-network-channel';
import { devicesChanged } from './annex-device-signal';

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
  /**
   * Devices with an authenticated network channel open to this machine now (#3608), checked
   * against its pinned certificate. With `connected` (pinned control sockets), that's inbound.
   */
  inbound?: ReadonlySet<string>;
  /** Whether this machine is listening for other computers. */
  serverOn?: boolean;
  /** This machine's main Annex port, for advice about forwards to it. */
  ownPort?: number;
  /** Direction observations over time; without one, no reach is reported. */
  reach?: ReachTracker;
  now?: number;
}

/**
 * How long a direction may be missing before it's reported down (#3608). A
 * computer that just connected one way usually connects back within a
 * reconnect round, so a shorter gap is reported as not known yet.
 */
export const REACH_SETTLE_MS = 30_000;

type Direction = 'outbound' | 'inbound';

/**
 * Remembers, per device and direction, when it was last up and since when it
 * hasn't been (#3608), and asks for the list to be built again once a gap has
 * lasted the settle window. Observations only: nothing here connects.
 */
export class ReachTracker {
  private seen = new Map<string, { lastUp?: number; missingSince?: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly onSettle: () => void = devicesChanged) {}

  /** `up` is an authenticated observation now; `failed` means an attempt this way has failed. */
  observe(fingerprint: string, direction: Direction, up: boolean, failed: boolean, now: number): AnnexDirection {
    const key = `${fingerprint.toLowerCase()}|${direction}`;
    const entry = this.seen.get(key) ?? {};
    this.seen.set(key, entry);
    const lastUp = (at: number | undefined) => (at !== undefined ? { lastUp: new Date(at).toISOString() } : {});
    if (up) {
      entry.lastUp = now;
      entry.missingSince = undefined;
      this.clear(key);
      return { state: 'up', ...lastUp(now) };
    }
    entry.missingSince ??= now;
    if (failed || now - entry.missingSince >= REACH_SETTLE_MS) {
      this.clear(key);
      return { state: 'down', ...lastUp(entry.lastUp) };
    }
    if (!this.timers.has(key)) {
      this.timers.set(key, setTimeout(() => { this.timers.delete(key); this.onSettle(); }, entry.missingSince + REACH_SETTLE_MS - now));
    }
    return { state: 'unknown', ...lastUp(entry.lastUp) };
  }

  /** Forgets a direction that isn't in use, so a later one starts fresh. */
  idle(fingerprint: string, direction: Direction): void {
    const key = `${fingerprint.toLowerCase()}|${direction}`;
    this.seen.delete(key);
    this.clear(key);
  }

  reset(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.seen.clear();
  }

  private clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
  }
}

const reachTracker = new ReachTracker();

/** For tests. */
export function resetReachForTests(): void {
  reachTracker.reset();
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
    inbound: networkChannel.inboundMembers(),
    serverOn: annexServer.getStatus().port > 0,
    ownPort: annexServer.getStatus().port || undefined,
    reach: reachTracker,
    now: Date.now(),
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

/**
 * Each direction with a computer on its own (#3608), and a notice when only one
 * works. Only authenticated connections count as up; membership says nothing.
 */
function reachFor(peer: AnnexPeer, sat: annexClient.SatelliteConnection | undefined, sources: Sources): AnnexDeviceReach | undefined {
  const tracker = sources.reach;
  if (!tracker || peer.kind === 'phone') return undefined;
  const now = sources.now ?? Date.now();
  const direction = (dir: Direction, used: boolean, on: boolean, up: boolean, failed: boolean): AnnexDirection => {
    if (!used) { tracker.idle(peer.fingerprint, dir); return { state: 'not-used' }; }
    if (!on) { tracker.idle(peer.fingerprint, dir); return { state: 'off' }; }
    return tracker.observe(peer.fingerprint, dir, up, failed, now);
  };
  const outbound = direction('outbound', annexPeers.controlledFromHere(peer), sources.clientOn,
    sat?.state === 'connected', !!sat && sat.state !== 'connected' && !!sat.problem);
  const inbound = direction('inbound', annexPeers.controlsThisMachine(peer), sources.serverOn ?? true,
    [sources.connected, sources.inbound].some((set) => !!set && (set.has(peer.fingerprint) || set.has(peer.fingerprint.toLowerCase()))), false);
  const name = peer.alias || 'That computer';
  let notice: AnnexDeviceReach['notice'];
  if (peer.role === 'member' && outbound.state === 'up' && inbound.state === 'down') {
    notice = {
      message: `You can reach ${name}, but it can't reach this computer.`,
      action: `On ${name}, open Annex Network in Settings and add an address for this computer.${sources.ownPort ? ` A forward there must reach port ${sources.ownPort} on this computer.` : ''}`,
    };
  } else if (peer.role === 'member' && inbound.state === 'up' && outbound.state === 'down') {
    // The specific advice when the address is a local forward, or this machine's own port.
    const specific = sat?.problem && (sat.problem.code === 'own-listener' || isAnnexLoopback(sat.host)) ? sat.problem.action : undefined;
    notice = {
      message: `${name} can reach this computer, but this computer can't reach it.`,
      action: specific ?? `Add an address for ${name} with Address, such as a local forward to its Annex port.`,
    };
  }
  return { outbound, inbound, ...(notice && { notice }) };
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
    if (annexPeers.peerNeedsPairing(peer) || sat?.needsPairing) state = 'needs-pairing';
    else if (peer.networkPending) {
      state = 'needs-pairing';
      problem = { code: 'connection-failed', message: `Waiting for ${peer.alias || 'this computer'} to confirm this computer's membership.`, action: 'Keep the phone connected to both computers to finish joining, or pair again.' };
    }
    // A member connected either way is connected (#3061).
    else if (peer.role === 'member' && sources.connected.has(peer.fingerprint)) state = 'connected';
    else if (annexPeers.controlledFromHere(peer) && !sources.clientOn) {
      // Not this satellite's doing: this machine isn't connecting to any.
      state = 'offline';
      problem = describeAnnexProblem('client-off', peer.alias);
    } else if (annexPeers.controlledFromHere(peer)) state = satelliteState(sat);
    else state = sources.connected.has(peer.fingerprint) ? 'connected' : 'offline';
    const reach = !sessionOnly && state !== 'needs-pairing' ? reachFor(peer, sat, sources) : undefined;
    devices.push({
      fingerprint: peer.fingerprint,
      alias: peer.alias || '',
      icon: peer.icon || 'computer',
      color: peer.color || 'indigo',
      role: peer.role ?? null,
      ...(peer.kind && { kind: peer.kind }),
      state,
      pairedAt: peer.pairedAt || '',
      lastSeen: peer.lastSeen || '',
      ...(sessionOnly && { sessionOnly: true }),
      ...(annexPeers.controlledFromHere(peer) && sat && sources.addressOf(peer.fingerprint) && { address: sources.addressOf(peer.fingerprint) }),
      ...(peer.typedHost && { typedHost: peer.typedHost }),
      problem: problem ?? problemFor(peer, state, sat),
      ...(joinConfirmation(peer) && { confirmation: joinConfirmation(peer)! }),
      ...(reach && { reach }),
      ...(peer.heldRoutes?.typedHost && { heldTypedHost: peer.heldRoutes.typedHost }),
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
      icon: r.kind === 'phone' ? 'iphone' : 'computer',
      color: 'indigo',
      role: 'member',
      ...(r.kind && { kind: r.kind }),
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
  // (forgetSatellite and revokePeer record it too; it's recorded once.)
  if (peer?.role === 'member') membership.noteLocalRemoval(fingerprint);
  // This machine's own connection to it, if it's (or was found as) a satellite here.
  const wasSatellite = annexPeers.controlledFromHere(peer) || annexClient.getSatellite(fingerprint) !== null;
  if (wasSatellite) annexClient.forgetSatellite(fingerprint);
  // Its entry, if still there, then any socket it has to this machine: cut, not left to close.
  const revoked = annexServer.revokePeer(fingerprint);
  return wasSatellite || revoked;
}
