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
import { randomUUID } from 'crypto';
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
  /** Kinds of removed devices, so a removed phone is shown as one. */
  removedKinds?: Record<string, 'desktop' | 'phone'>;
  /** When this machine last joined a network by pairing (ISO): an older removal of it is stale. */
  selfJoinedAt?: string;
  /** The pairing that put this machine in its network (#3107), as members know it. */
  selfPairing?: { id: string; joinedAt: string };
}

const EMPTY: MembershipState = { removals: [], confirmations: {}, renamedAt: {}, removedNames: {} };
const store = createSettingsStore<MembershipState>('annex-network.json', EMPTY, undefined, { mode: 0o600 });

function state(): MembershipState {
  const s = store.get();
  return {
    removals: s.removals ?? [], confirmations: s.confirmations ?? {}, renamedAt: s.renamedAt ?? {}, removedNames: s.removedNames ?? {}, removedKinds: s.removedKinds ?? {},
    ...(s.selfJoinedAt && { selfJoinedAt: s.selfJoinedAt }),
    ...(s.selfPairing && { selfPairing: s.selfPairing }),
  };
}

/** Removals kept. A view must stay well under the protocol's limit (NETWORK_MEMBERS_MAX * 4). */
const REMOVALS_KEPT = 200;

const changeListeners = new Set<() => void>();

/** Hears every change to the membership (for pushing it to phones, #3062). */
export function onMembershipChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

function save(next: MembershipState): void {
  if (next.removals.length > REMOVALS_KEPT) {
    next.removals = [...next.removals].sort((x, y) => Date.parse(y.removedAt) - Date.parse(x.removedAt)).slice(0, REMOVALS_KEPT);
  }
  void Promise.resolve(store.save(next)).catch((err: unknown) => {
    appLog('core:annex', 'warn', 'Could not save Annex Network state', { meta: { error: err instanceof Error ? err.message : String(err) } });
  });
  devicesChanged();
  for (const listener of [...changeListeners]) {
    try { listener(); } catch { /* telemetry-exempt: one listener failing must not stop the others */ }
  }
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
  networkChannel.setSelfPairingProvider(() => state().selfPairing);
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
    ...(peer.pairingId && { pairingId: peer.pairingId }),
  };
}

/** Peers that are members of this machine's network. */
export function memberPeers(): AnnexPeer[] {
  return annexPeers.listPeers().filter((p) => p.role === 'member' && !annexPeers.peerNeedsPairing(p));
}

/**
 * Everything this machine knows: itself, its members, and the removals it has
 * seen. Given `to`, a device that isn't a member (or with Annex Network off)
 * hears only about this machine.
 */
export function currentView(to?: string): { members: NetworkMember[]; removals: NetworkRemoval[] } {
  const members: NetworkMember[] = [];
  const self = networkChannel.localMember();
  if (self) members.push(self);
  if (to !== undefined && (!annexSettings.networkEnabled() || annexPeers.getPeer(to)?.role !== 'member')) {
    return { members, removals: [] };
  }
  for (const peer of memberPeers()) {
    const m = toMember(peer);
    if (m) members.push(m);
  }
  return { members, removals: state().removals };
}

/** Only members hear about the network. */
function toMembers(): (fp: string) => boolean {
  const members = new Set(memberPeers().map((p) => lower(p.fingerprint)));
  return (fp) => members.has(lower(fp));
}

function sendView(): void {
  if (!annexSettings.networkEnabled()) return;
  const view = currentView();
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'members', members: view.members, removals: view.removals }, toMembers());
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

/** A pairing into the network: its id (when known) and its join time, set together and never moved apart (#3107). */
interface Pairing { pairingId?: string; joinedAt: string }

const pairingOf = (peer: AnnexPeer): Pairing => ({ pairingId: peer.pairingId, joinedAt: peer.pairedAt || new Date(0).toISOString() });

/** Whether `a` is a later pairing than `b`: another id, joined later. The same id is the same pairing. */
function laterPairing(a: Pairing, b: Pairing): boolean {
  if (a.pairingId && a.pairingId === b.pairingId) return false;
  return Date.parse(a.joinedAt) > Date.parse(b.joinedAt);
}

/**
 * Whether a removal ends a pairing: the one it names, or an older one; never a
 * later one (#3107). A record whose pairing isn't known yet (a desktop this
 * machine just paired with) counts as the one named. A removal from before
 * removals named their pairing is compared by its time.
 */
function endsPairing(removal: NetworkRemoval, pairing: Pairing): boolean {
  if (removal.pairingId) {
    if (!pairing.pairingId || pairing.pairingId === removal.pairingId) return true;
    return !!removal.joinedAt && Date.parse(pairing.joinedAt) <= Date.parse(removal.joinedAt);
  }
  return Date.parse(removal.removedAt) >= Date.parse(pairing.joinedAt);
}

/** Whether a kept removal covers one that arrives: it ends a later pairing, or the same one no earlier. */
function covers(known: NetworkRemoval, incoming: NetworkRemoval): boolean {
  if (known.pairingId && incoming.pairingId && known.pairingId !== incoming.pairingId && known.joinedAt && incoming.joinedAt) {
    return Date.parse(known.joinedAt) > Date.parse(incoming.joinedAt);
  }
  return Date.parse(known.removedAt) >= Date.parse(incoming.removedAt);
}

/** Removed since it joined: a removal ends the pairing it names and older ones, never a later one. */
function removedSince(member: Pairing & { fingerprint: string }, s: MembershipState): boolean {
  const removal = removalOf(member.fingerprint, s);
  return !!removal && endsPairing(removal, member);
}

/** Learns which pairing put this machine in its network, from a member's record of it. */
function learnSelfPairing(member: NetworkMember, s: MembershipState): boolean {
  // Only when it isn't known: this machine's pairing comes from the pairing answer (or its own, for the
  // first machine), and a member's record of it can't move it (#3107).
  if (!member.pairingId || s.selfPairing) return false;
  s.selfPairing = { id: member.pairingId, joinedAt: member.joinedAt };
  return true;
}

/** A pairing as the pairing exchange carries it: an id and its join time. */
export interface PairingRecord { id: string; joinedAt: string }

const PAIRING_ID = /^[A-Za-z0-9-]{8,64}$/;

/** A pairing record that holds together, from a pairing request or answer. */
export function readPairing(value: unknown): PairingRecord | undefined {
  const v = value as { id?: unknown; joinedAt?: unknown } | null;
  if (!v || typeof v.id !== 'string' || !PAIRING_ID.test(v.id) || typeof v.joinedAt !== 'string' || Number.isNaN(Date.parse(v.joinedAt))) return undefined;
  return { id: v.id, joinedAt: v.joinedAt };
}

/** This machine's own pairing into its network, if it has one. */
export function ownPairing(): PairingRecord | undefined {
  return state().selfPairing;
}

/** This machine's own pairing, made now when it has none: the first machine of a network starts it (#3107). */
export function ensureOwnPairing(): PairingRecord {
  const s = state();
  if (s.selfPairing) return s.selfPairing;
  s.selfPairing = { id: randomUUID(), joinedAt: new Date().toISOString() };
  save(s);
  return s.selfPairing;
}

/**
 * The pairing a device joining here gets (#3107): the one it already has in the
 * network, if it says so and no removal here ends it, so a member pairing with
 * another desktop keeps its pairing; otherwise a new one, made here, once.
 */
export function pairingForJoiner(fingerprint: string, offered: PairingRecord | undefined): PairingRecord {
  const removal = removalOf(fingerprint);
  if (offered && !(removal && endsPairing(removal, { pairingId: offered.id, joinedAt: offered.joinedAt }))) return offered;
  return { id: randomUUID(), joinedAt: new Date().toISOString() };
}

/** Takes this machine's own pairing from a pairing answer (#3107): what the member it paired with says it is. */
export function adoptOwnPairing(pairing: PairingRecord): void {
  const s = state();
  if (s.selfPairing?.id === pairing.id) return;
  s.selfPairing = pairing;
  save(s);
}

function isSelf(fingerprint: string): boolean {
  const self = annexIdentity.getIdentity();
  return !!self && lower(self.fingerprint) === lower(fingerprint);
}

/** Removals this machine tracks confirmations for (it made them). */
function removalKeys(s: MembershipState): Record<string, true> {
  const out: Record<string, true> = {};
  for (const key of Object.keys(s.confirmations)) if (key.startsWith('remove:')) out[key.slice(7)] = true;
  return out;
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
function addMember(input: NetworkMember, from: string, s: MembershipState): boolean {
  // One spelling of a fingerprint everywhere: the protocol takes either case.
  const member: NetworkMember = { ...input, fingerprint: lower(input.fingerprint) };
  if (isSelf(member.fingerprint)) return learnSelfPairing(member, s);
  if (removedSince(member, s)) return false;
  // A pairing later than the one a kept removal ended makes that removal stale: stop passing it on.
  const stale = removalOf(member.fingerprint, s);
  if (stale && !endsPairing(stale, member)) {
    s.removals = s.removals.filter((r) => r !== stale);
  }
  const existing = annexPeers.getPeer(member.fingerprint);
  if (existing) {
    // One-to-one pairings keep working as they are until they're paired again.
    if (existing.role !== 'member') return !!stale;
    // A member we know: learn a newer join, and new addresses. Its own hello says where it is now.
    const own = lower(from) === lower(member.fingerprint);
    const hosts = own
      ? [...new Set([...member.hosts, ...(existing.knownHosts ?? [])])].slice(0, 6)
      : [...new Set([...(existing.knownHosts ?? []), ...member.hosts])].slice(0, 6);
    const port = own ? member.port || existing.mainPort : existing.mainPort || member.port;
    // Its pairing moves only with a pairing id (#3107): the one it hadn't learned yet, or a later pairing (paired
    // again). A record without one (a member's own clock, or a desktop's stamp from pairing with it) never moves it.
    const adopt = !!member.pairingId && (!existing.pairingId || laterPairing(member, pairingOf(existing)));
    const joinedAt = adopt ? member.joinedAt : existing.pairedAt;
    const pairingId = adopt ? member.pairingId : existing.pairingId;
    const name = own && member.name !== existing.alias ? member.name : existing.alias;
    const moved = hosts.join() !== (existing.knownHosts ?? []).join() || port !== existing.mainPort;
    // Paired again since with a new certificate (the pairing member checked its binding): pin the new one.
    const repinned = adopt && !!existing.pairingId && pairingId !== existing.pairingId
      && !annexTls.sameCertificateFingerprint(member.certFingerprint, existing.tlsCertificateFingerprint) && proves(member);
    if (moved || repinned || joinedAt !== existing.pairedAt || pairingId !== existing.pairingId || name !== existing.alias) {
      annexPeers.addPeer({
        ...existing, knownHosts: hosts, pairedAt: joinedAt, alias: name, ...(port && { mainPort: port }),
        ...(pairingId && { pairingId }),
        ...(repinned && { tlsCertificateFingerprint: member.certFingerprint, tlsCertificatePem: member.certPem }),
      });
      // Now there's somewhere to reach it (connecting to one already connected does nothing).
      if (moved && (existing.kind ?? 'desktop') === 'desktop' && port && annexSettings.getSettings().enableClient) hooks?.connect(lower(existing.fingerprint));
      return true;
    }
    return !!stale;
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
    ...(member.pairingId && { pairingId: member.pairingId }),
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
  if (known && covers(known, removal)) return false;
  const peer = annexPeers.getPeer(removal.fingerprint);
  // A pairing later than the one it ended stays (#3107): the device was paired again since.
  if (peer && peer.role === 'member' && !endsPairing(removal, pairingOf(peer))) return false;
  // A removal of this machine from before it last joined is stale: by its pairing when both name one, else by time.
  if (isSelf(removal.fingerprint)) {
    const self = s.selfPairing;
    if (removal.pairingId && self) {
      if (!endsPairing(removal, { pairingId: self.id, joinedAt: self.joinedAt })) return false;
    } else if (s.selfJoinedAt && Date.parse(removal.removedAt) <= Date.parse(s.selfJoinedAt)) {
      return false;
    }
  }
  s.removals = [...s.removals.filter((r) => lower(r.fingerprint) !== lower(removal.fingerprint)), removal];
  if (lower(removal.fingerprint) in removalKeys(s)) confirm(s, `remove:${lower(removal.fingerprint)}`, from);
  if (isSelf(removal.fingerprint)) {
    leaveNetwork(from, s);
    return true;
  }
  // Only a member is removed by another member's word; a one-to-one pairing stays.
  if (peer?.role === 'member') {
    s.removedNames[lower(removal.fingerprint)] = peer.alias;
    s.removedKinds = { ...(s.removedKinds ?? {}), [lower(removal.fingerprint)]: peer.kind ?? 'desktop' };
    // Saved before it's ended, so what it's told on the way out (a phone's last view) has the removal.
    save(s);
    appLog('core:annex', 'info', 'A device was removed from the network by another member', { meta: { fingerprint: removal.fingerprint, from } });
    hooks?.endDevice(removal.fingerprint);
  }
  return true;
}

/** This machine was removed: it stops being a member of every member it knew. */
function leaveNetwork(from: string, s: MembershipState): void {
  appLog('core:annex', 'warn', 'This computer was removed from its Annex Network', { meta: { from } });
  // Ending its pairings here is leaving, not removing anyone: nothing is recorded or told to the others.
  // Otherwise a member that hadn't heard of this machine's removal yet would be told to remove itself.
  leaving = true;
  try {
    for (const peer of memberPeers()) hooks?.endDevice(peer.fingerprint);
  } finally {
    leaving = false;
  }
  // Its pairing ended with it: pairing again makes a new one (#3107). Cleared on the state the caller saves.
  delete s.selfPairing;
}

/** While this machine leaves the network: the pairings it ends are its own, not removals to announce. */
let leaving = false;

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
      // Only joins and removals this machine made are tracked.
      for (const peer of memberPeers()) {
        const key = `join:${lower(peer.fingerprint)}`;
        if (key in s.confirmations && theirs.has(lower(peer.fingerprint))) confirmed = confirm(s, key, from) || confirmed;
      }
      for (const removal of message.removals) {
        const ours = removalOf(removal.fingerprint, s);
        // Theirs confirms ours when it ends the same pairing or a later one (#3107).
        if (ours && `remove:${lower(removal.fingerprint)}` in s.confirmations && covers(removal, ours)) {
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

export interface VouchResult {
  /** Fingerprints added as members. */
  added: string[];
  /** Records not added, each with why: already a member, paired one-to-one here, this machine, or a record that doesn't hold together. */
  skipped: Array<{ fingerprint: string; reason: 'member' | 'one-to-one' | 'self' | 'invalid' }>;
}

/**
 * A phone that's a member vouches for devices (#3062): the network's members,
 * sent to a desktop it just paired, or that desktop, sent to a member. A person
 * is joining them now, through the phone, so it counts as a fresh join, as a
 * pairing does: any earlier removal of them is stale. Each is otherwise added as
 * if a member had said so.
 */
export function vouchFromPhone(phone: string, members: NetworkMember[]): VouchResult {
  const result: VouchResult = { added: [], skipped: [] };
  if (!annexSettings.networkEnabled()) return result;
  const sender = annexPeers.getPeer(phone);
  if (sender?.role !== 'member' || sender.kind !== 'phone') return result;
  const s = state();
  const now = new Date().toISOString();
  for (const input of members) {
    const fp = lower(input.fingerprint);
    if (isSelf(fp)) { result.skipped.push({ fingerprint: fp, reason: 'self' }); continue; }
    const existing = annexPeers.getPeer(fp);
    if (existing && existing.role !== 'member') { result.skipped.push({ fingerprint: fp, reason: 'one-to-one' }); continue; }
    if (existing) { result.skipped.push({ fingerprint: fp, reason: 'member' }); continue; }
    if (!proves(input)) { result.skipped.push({ fingerprint: fp, reason: 'invalid' }); continue; }
    // It keeps the pairing it has in the network; one a removal here ended (or none) is a new pairing, made here (#3107).
    const removal = removalOf(fp, s);
    const keeps = input.pairingId && !(removal && endsPairing(removal, input));
    s.removals = s.removals.filter((r) => lower(r.fingerprint) !== fp);
    if (addMember(keeps ? input : { ...input, joinedAt: now, pairingId: randomUUID() }, phone, s)) {
      result.added.push(fp);
      s.confirmations[`join:${fp}`] = [];
    }
  }
  // Joining through the phone counts as this machine joining too: an old removal of it is stale.
  if (result.added.length > 0) {
    s.selfJoinedAt = now;
    s.removals = s.removals.filter((r) => !isSelf(r.fingerprint));
  }
  save(s);
  if (result.added.length > 0) sendView();
  return result;
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
  // This machine joined (or rejoined) now: any removal of it from before is stale.
  s.selfJoinedAt = new Date().toISOString();
  s.removals = s.removals.filter((r) => !isSelf(r.fingerprint));
  save(s);
  sendView();
}

/**
 * Removing a member here: record it, then tell every member, the removed device
 * included, before its connections are cut. Members that are off hear later.
 */
export function noteLocalRemoval(fingerprint: string): void {
  if (leaving) return;
  const peer = annexPeers.getPeer(fingerprint);
  if (peer?.role !== 'member') return;
  const s = state();
  // Already removed since it joined (by this path a moment ago, or by another member): once is enough.
  const known = removalOf(fingerprint, s);
  if (known && endsPairing(known, pairingOf(peer))) return;
  // Named by the pairing it ends, so a later pairing anywhere is never undone by it (#3107).
  const pairing = pairingOf(peer);
  const removal: NetworkRemoval = {
    fingerprint: lower(fingerprint), removedAt: new Date().toISOString(),
    ...(pairing.pairingId && { pairingId: pairing.pairingId }), joinedAt: pairing.joinedAt,
  };
  s.removals = [...s.removals.filter((r) => lower(r.fingerprint) !== lower(fingerprint)), removal];
  s.confirmations[`remove:${lower(fingerprint)}`] = [];
  s.removedNames[lower(fingerprint)] = peer.alias;
  s.removedKinds = { ...(s.removedKinds ?? {}), [lower(fingerprint)]: peer.kind ?? 'desktop' };
  delete s.confirmations[`join:${lower(fingerprint)}`];
  save(s);
  // Every member, the removed one included (it's still a member until its connections are cut).
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'member-removed', removal }, toMembers());
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
  networkChannel.broadcast({ v: NETWORK_PROTOCOL_VERSION, type: 'member-renamed', fingerprint: peer.fingerprint, name: trimmed, at }, toMembers());
  return true;
}

// ---------------------------------------------------------------------------
// Where joins and removals are confirmed (for Settings, #3067)
// ---------------------------------------------------------------------------

export interface NetworkConfirmation {
  fingerprint: string;
  /** Its name, for a removed device that's no longer in the peer list. */
  name?: string;
  /** Its kind, for a removed device. */
  kind?: 'desktop' | 'phone';
  /** Members whose view shows it. */
  confirmedBy: string[];
  /** Members it hasn't reached yet (they may be off). */
  waitingOn: string[];
}

function confirmationFor(key: string, subject: string, s: MembershipState): NetworkConfirmation {
  const confirmedBy = (s.confirmations[key] ?? []).filter((fp) => lower(fp) !== lower(subject));
  // Phones never open the membership channel, so they can't confirm: only computers are waited on.
  const waitingOn = memberPeers()
    .filter((p) => p.kind !== 'phone')
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

/** Removals made on this machine that haven't reached every member yet (ones heard from others aren't tracked here). */
export function pendingRemovals(): NetworkConfirmation[] {
  const s = state();
  return s.removals
    .filter((r) => `remove:${lower(r.fingerprint)}` in s.confirmations)
    .map((r) => ({ ...confirmationFor(`remove:${lower(r.fingerprint)}`, r.fingerprint, s), name: s.removedNames[lower(r.fingerprint)], kind: s.removedKinds?.[lower(r.fingerprint)] }))
    .filter((c) => c.waitingOn.length > 0);
}

/** Test helper. */
export function resetMembershipForTests(): void {
  unsubscribe?.();
  unsubscribe = null;
  hooks = null;
  store.save({ ...EMPTY });
}
