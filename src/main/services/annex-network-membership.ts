/**
 * Annex Network membership (#3061): join once, removed everywhere.
 *
 * A member is a paired peer with role `member` (`annex-peers.json`). This module
 * keeps the rest: removals (kept, so members that were off learn of them) and
 * which members have confirmed each join and removal. It talks over the
 * membership channel (`annex-network-channel.ts`), and only to members.
 *
 * - Pairing a new desktop with any member makes it a member there; that member
 *   then tells the others, and each of them pins it and connects to it.
 * - Removing a device here tells every member, and each removes it. A member
 *   that was off hears on its next connection, from whichever member it reaches.
 * - Every channel opens with each side's full view (`members`), so the two
 *   catch up both ways. A change is sent to every connected member as a new full
 *   view; the same view arriving twice changes nothing.
 * - A member is trusted because a member vouches for it, and its record proves
 *   itself: the public key hashes to its fingerprint, and the certificate to its
 *   certificate fingerprint. Direct only: members connect to each other, never
 *   through another.
 */
import { createSettingsStore } from './settings-store';
import type { AnnexPeer } from '../../shared/types';
import {
  NETWORK_PROTOCOL_VERSION,
  type NetworkMember,
  type NetworkMessage,
  type NetworkRemoval,
} from '../../shared/annex-network-protocol';
import * as annexPeers from './annex-peers';
import * as annexIdentity from './annex-identity';
import * as annexSettings from './annex-settings';
import * as annexTls from './annex-tls';
import * as networkChannel from './annex-network-channel';
import { devicesChanged } from './annex-device-signal';
import { appLog } from './log-service';

// ---------------------------------------------------------------------------
// Stored state
// ---------------------------------------------------------------------------

interface MembershipState {
  /** Devices removed from the network, newest removal per device. */
  removals: NetworkRemoval[];
  /** `join:<fp>` or `remove:<fp>` → fingerprints of members whose view shows it. */
  confirmations: Record<string, string[]>;
  /** Latest rename seen per device (ISO time), so an older one never wins. */
  renamedAt: Record<string, string>;
  /** Names of removed devices, for showing where a removal is confirmed. */
  removedNames: Record<string, string>;
}

const EMPTY: MembershipState = { removals: [], confirmations: {}, renamedAt: {}, removedNames: {} };
const store = createSettingsStore<MembershipState>('annex-network.json', EMPTY, undefined, { mode: 0o600 });

function state(): MembershipState {
  const s = store.get();
  return { removals: s.removals ?? [], confirmations: s.confirmations ?? {}, renamedAt: s.renamedAt ?? {}, removedNames: s.removedNames ?? {} };
}

function save(next: MembershipState): void {
  void Promise.resolve(store.save(next)).catch((err: unknown) => {
    appLog('core:annex', 'warn', 'Could not save Annex Network state', { meta: { error: err instanceof Error ? err.message : String(err) } });
  });
  devicesChanged();
}

const lower = (fp: string) => fp.toLowerCase();

// ---------------------------------------------------------------------------
// Hooks (set at start, so this module needs no client or server import)
// ---------------------------------------------------------------------------

interface Hooks {
  /** Start connecting to a member this machine just learned of. */
  connect: (fingerprint: string) => void;
  /** End everything with a device: forget it as a satellite, revoke it, close its sockets. */
  endDevice: (fingerprint: string) => void;
}

let hooks: Hooks | null = null;
let unsubscribe: (() => void) | null = null;

/** Starts listening on the membership channel. Called once at startup. */
export function initNetworkMembership(h: Hooks): void {
  hooks = h;
  networkChannel.setMembersProvider(currentView);
  unsubscribe?.();
  unsubscribe = networkChannel.onNetworkMessage(onMessage);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** A member peer as the protocol describes it. */
function toMember(peer: AnnexPeer): NetworkMember | null {
  if (!peer.tlsCertificateFingerprint || !peer.tlsCertificatePem) return null;
  return {
    fingerprint: peer.fingerprint,
    publicKey: peer.publicKey,
    certFingerprint: peer.tlsCertificateFingerprint,
    certPem: peer.tlsCertificatePem,
    name: (peer.alias || 'Computer').slice(0, 200),
    icon: peer.icon || 'computer',
    color: peer.color || 'indigo',
    kind: peer.kind ?? 'desktop',
    hosts: (peer.knownHosts ?? []).slice(0, 8),
    ...(peer.mainPort && peer.mainPort > 0 && { port: peer.mainPort }),
    joinedAt: peer.pairedAt || new Date(0).toISOString(),
  };
}

/** Peers that are members of this machine's network. */
export function memberPeers(): AnnexPeer[] {
  return annexPeers.listPeers().filter((p) => p.role === 'member' && !annexPeers.peerNeedsPairing(p));
}

/** Everything this machine knows: itself, its members, and the removals it has seen. */
export function currentView(): { members: NetworkMember[]; removals: NetworkRemoval[] } {
  const members: NetworkMember[] = [];
  const self = networkChannel.localMember();
  if (self) members.push(self);
  for (const peer of memberPeers()) {
    const m = toMember(peer);
    if (m) members.push(m);
  }
  return { members, removals: state().removals };
}

function sendView(): void {
  if (!annexSettings.networkEnabled()) return;
  const view = currentView();
  const members = new Set(memberPeers().map((p) => lower(p.fingerprint)));
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'members', members: view.members, removals: view.removals },
    (fp) => members.has(lower(fp)));
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** The record proves itself: key → fingerprint, certificate → certificate fingerprint. */
function proves(member: NetworkMember): boolean {
  if (!member.certPem) return false;
  try {
    return lower(annexIdentity.computeFingerprint(member.publicKey)) === lower(member.fingerprint)
      && annexTls.sameCertificateFingerprint(annexTls.certificateFingerprint(member.certPem), member.certFingerprint);
  } catch { // telemetry-exempt: a record that can't be read doesn't prove itself
    return false;
  }
}

function removalOf(fingerprint: string, s: MembershipState = state()): NetworkRemoval | undefined {
  return s.removals.find((r) => lower(r.fingerprint) === lower(fingerprint));
}

/** Removed after it joined: a removal wins over the join it followed, and loses to a later join. */
function removedSince(member: { fingerprint: string; joinedAt: string }, s: MembershipState): boolean {
  const removal = removalOf(member.fingerprint, s);
  return !!removal && Date.parse(removal.removedAt) >= Date.parse(member.joinedAt);
}

function isSelf(fingerprint: string): boolean {
  const self = annexIdentity.getIdentity();
  return !!self && lower(self.fingerprint) === lower(fingerprint);
}

function confirm(s: MembershipState, key: string, by: string): boolean {
  const list = s.confirmations[key] ?? [];
  if (list.some((fp) => lower(fp) === lower(by))) return false;
  s.confirmations[key] = [...list, by];
  return true;
}

// ---------------------------------------------------------------------------
// Merging what a member says
// ---------------------------------------------------------------------------

/** Adds a member another member vouched for. Returns whether anything changed. */
function addMember(member: NetworkMember, from: string, s: MembershipState): boolean {
  if (isSelf(member.fingerprint) || removedSince(member, s)) return false;
  const existing = annexPeers.getPeer(member.fingerprint);
  if (existing) {
    // One-to-one pairings keep working as they are until they're paired again.
    if (existing.role !== 'member') return false;
    // A member we know: learn new addresses for it (from its own hello, or a member's view).
    const hosts = [...new Set([...(existing.knownHosts ?? []), ...member.hosts])].slice(0, 6);
    const port = existing.mainPort || member.port;
    if (hosts.length !== (existing.knownHosts ?? []).length || port !== existing.mainPort) {
      annexPeers.addPeer({ ...existing, knownHosts: hosts, ...(port && { mainPort: port }) });
      // Now there's somewhere to reach it (connecting to one already connected does nothing).
      if ((existing.kind ?? 'desktop') === 'desktop' && port && annexSettings.getSettings().enableClient) hooks?.connect(lower(existing.fingerprint));
      return true;
    }
    return false;
  }
  if (!proves(member)) {
    appLog('core:annex', 'warn', 'Ignored a network member whose record does not prove itself', { meta: { fingerprint: member.fingerprint, from } });
    return false;
  }
  annexPeers.addPeer({
    fingerprint: lower(member.fingerprint),
    publicKey: member.publicKey,
    alias: member.name,
    icon: member.icon,
    color: member.color,
    pairedAt: member.joinedAt,
    lastSeen: '',
    role: 'member',
    kind: member.kind,
    addedBy: from,
    tlsCertificateFingerprint: member.certFingerprint,
    tlsCertificatePem: member.certPem,
    knownHosts: member.hosts.slice(0, 6),
    ...(member.port && { mainPort: member.port }),
  });
  appLog('core:annex', 'info', 'A device joined the network through another member', { meta: { fingerprint: member.fingerprint, from } });
  if (member.kind === 'desktop' && annexSettings.getSettings().enableClient) hooks?.connect(lower(member.fingerprint));
  return true;
}

/** Applies a removal. Returns whether anything changed. */
function applyRemoval(removal: NetworkRemoval, from: string, s: MembershipState): boolean {
  const known = removalOf(removal.fingerprint, s);
  if (known && Date.parse(known.removedAt) >= Date.parse(removal.removedAt)) return false;
  const peer = annexPeers.getPeer(removal.fingerprint);
  // A later join beats an earlier removal.
  if (peer && peer.role === 'member' && Date.parse(peer.pairedAt) > Date.parse(removal.removedAt)) return false;
  s.removals = [...s.removals.filter((r) => lower(r.fingerprint) !== lower(removal.fingerprint)), removal];
  confirm(s, `remove:${lower(removal.fingerprint)}`, from);
  if (isSelf(removal.fingerprint)) {
    leaveNetwork(from);
    return true;
  }
  if (peer) {
    s.removedNames[lower(removal.fingerprint)] = peer.alias;
    appLog('core:annex', 'info', 'A device was removed from the network by another member', { meta: { fingerprint: removal.fingerprint, from } });
    hooks?.endDevice(removal.fingerprint);
  }
  return true;
}

/** This machine was removed: it stops being a member of every member it knew. */
function leaveNetwork(from: string): void {
  appLog('core:annex', 'warn', 'This computer was removed from its Annex Network', { meta: { from } });
  for (const peer of memberPeers()) hooks?.endDevice(peer.fingerprint);
}

function onMessage(from: string, message: NetworkMessage): void {
  if (!annexSettings.networkEnabled()) return;
  // Only members speak for the network. One-to-one pairings are heard, not followed.
  const sender = annexPeers.getPeer(from);
  if (sender?.role !== 'member') return;
  const s = state();
  let changed = false;
  let confirmed = false;

  switch (message.type) {
    case 'hello':
      changed = addMember(message.member, from, s) || changed;
      break;
    case 'member-joined':
      changed = addMember(message.member, from, s) || changed;
      break;
    case 'member-removed':
      changed = applyRemoval(message.removal, from, s) || changed;
      break;
    case 'members': {
      for (const removal of message.removals) changed = applyRemoval(removal, from, s) || changed;
      for (const member of message.members) changed = addMember(member, from, s) || changed;
      // What this sender's view shows is confirmed by it.
      const theirs = new Set(message.members.map((m) => lower(m.fingerprint)));
      for (const peer of memberPeers()) {
        if (theirs.has(lower(peer.fingerprint))) confirmed = confirm(s, `join:${lower(peer.fingerprint)}`, from) || confirmed;
      }
      for (const removal of message.removals) {
        const ours = removalOf(removal.fingerprint, s);
        if (ours && Date.parse(removal.removedAt) >= Date.parse(ours.removedAt)) {
          confirmed = confirm(s, `remove:${lower(removal.fingerprint)}`, from) || confirmed;
        }
      }
      break;
    }
    case 'member-renamed': {
      const peer = annexPeers.getPeer(message.fingerprint);
      const last = s.renamedAt[lower(message.fingerprint)];
      if (peer?.role === 'member' && (!last || Date.parse(message.at) > Date.parse(last)) && peer.alias !== message.name) {
        annexPeers.addPeer({ ...peer, alias: message.name });
        s.renamedAt[lower(message.fingerprint)] = message.at;
        changed = true;
      }
      break;
    }
  }
  if (changed || confirmed) save(s);
  if (changed) sendView();
}

// ---------------------------------------------------------------------------
// Local actions
// ---------------------------------------------------------------------------

/** A device just paired here as a member: tell the others (#3061). */
export function noteLocalJoin(fingerprint: string): void {
  const s = state();
  // A new pairing beats an old removal of the same device.
  s.removals = s.removals.filter((r) => lower(r.fingerprint) !== lower(fingerprint));
  s.confirmations[`join:${lower(fingerprint)}`] = [];
  delete s.confirmations[`remove:${lower(fingerprint)}`];
  save(s);
  sendView();
}

/**
 * Removing a member here: record it, then tell every member, the removed device
 * included, before its connections are cut. Members that are off hear later.
 */
export function noteLocalRemoval(fingerprint: string): void {
  const peer = annexPeers.getPeer(fingerprint);
  if (peer?.role !== 'member') return;
  const s = state();
  const removal: NetworkRemoval = { fingerprint: lower(fingerprint), removedAt: new Date().toISOString() };
  s.removals = [...s.removals.filter((r) => lower(r.fingerprint) !== lower(fingerprint)), removal];
  s.confirmations[`remove:${lower(fingerprint)}`] = [];
  s.removedNames[lower(fingerprint)] = peer.alias;
  delete s.confirmations[`join:${lower(fingerprint)}`];
  save(s);
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'member-removed', removal });
  sendView();
}

/** Renames a member everywhere. */
export function renameMember(fingerprint: string, name: string): boolean {
  const peer = annexPeers.getPeer(fingerprint);
  const trimmed = name.trim().slice(0, 200);
  if (peer?.role !== 'member' || !trimmed) return false;
  const at = new Date().toISOString();
  annexPeers.addPeer({ ...peer, alias: trimmed });
  const s = state();
  s.renamedAt[lower(fingerprint)] = at;
  save(s);
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'member-renamed', fingerprint: peer.fingerprint, name: trimmed, at });
  return true;
}

// ---------------------------------------------------------------------------
// Where joins and removals are confirmed (for Settings, #3067)
// ---------------------------------------------------------------------------

export interface NetworkConfirmation {
  fingerprint: string;
  /** Its name, for a removed device that's no longer in the peer list. */
  name?: string;
  /** Members whose view shows it. */
  confirmedBy: string[];
  /** Members it hasn't reached yet (they may be off). */
  waitingOn: string[];
}

function confirmationFor(key: string, subject: string, s: MembershipState): NetworkConfirmation {
  const confirmedBy = (s.confirmations[key] ?? []).filter((fp) => lower(fp) !== lower(subject));
  const waitingOn = memberPeers()
    .map((p) => p.fingerprint)
    .filter((fp) => lower(fp) !== lower(subject) && !confirmedBy.some((c) => lower(c) === lower(fp)));
  return { fingerprint: subject, confirmedBy, waitingOn };
}

/** A join's confirmations, or null when it isn't one this machine tracks. */
export function joinConfirmation(fingerprint: string): NetworkConfirmation | null {
  const s = state();
  const key = `join:${lower(fingerprint)}`;
  return key in s.confirmations ? confirmationFor(key, fingerprint, s) : null;
}

/** Removals that haven't reached every member yet. */
export function pendingRemovals(): NetworkConfirmation[] {
  const s = state();
  return s.removals
    .map((r) => ({ ...confirmationFor(`remove:${lower(r.fingerprint)}`, r.fingerprint, s), name: s.removedNames[lower(r.fingerprint)] }))
    .filter((c) => c.waitingOn.length > 0);
}

/** Test helper. */
export function resetMembershipForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  hooks = null;
  store.save({ ...EMPTY });
}
