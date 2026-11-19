/**
 * Annex V2 Peer Management (#860)
 *
 * CRUD operations for paired peers, stored in ${userData}/annex-peers.json.
 * Includes brute-force protection for the pairing endpoint.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { annexEphemeralSession } from './annex-network-profile';
import { appLog } from './log-service';
import { devicesChanged, type DeviceChange } from './annex-device-signal';
import { isAnnexLoopback } from '../../shared/annex-problems';
import { formatAddress, hostPortsWithFallback, isPrivateHost, KNOWN_HOSTS_MAX, parseTypedHost, rememberHost, withPrivateHost } from './annex-reach';
import type { DisplayReceipt, DisplayValue } from './display-settings';
import type { AnnexHeldRoutes, AnnexPeer, AnnexPeerListing } from '../../shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PEERS_FILENAME = 'annex-peers.json';

// Brute-force protection
const MAX_FREE_ATTEMPTS = 3;
const MAX_TOTAL_ATTEMPTS = 6;
const BACKOFF_DELAYS_MS = [5_000, 15_000, 45_000]; // delays for attempts 4, 5, 6

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let cachedPeers: AnnexPeer[] | null = null;

// Brute-force state: per-source IP
interface BruteForceEntry {
  attempts: number;
  lastAttempt: number;
  lockedUntil: number;
}
const bruteForceState = new Map<string, BruteForceEntry>();

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function getPeersPath(): string {
  return path.join(app.getPath('userData'), PEERS_FILENAME);
}

function loadPeers(): AnnexPeer[] {
  if (annexEphemeralSession()) return cachedPeers ?? (cachedPeers = []);
  if (cachedPeers) return cachedPeers;

  try {
    const raw = fs.readFileSync(getPeersPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    cachedPeers = Array.isArray(parsed) ? (parsed as AnnexPeer[]).map(withHostPorts) : [];
    return cachedPeers;
  } catch {
    cachedPeers = [];
    return cachedPeers;
  }
}

function savePeers(peers: AnnexPeer[], change: DeviceChange = 'topology'): void {
  const ephemeral = annexEphemeralSession();
  cachedPeers = peers;
  devicesChanged(change);
  if (ephemeral) return;
  // Readable by this user only: the file holds the certificates paired devices are trusted by.
  const target = getPeersPath();
  fs.writeFileSync(target, JSON.stringify(peers, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* telemetry-exempt: no POSIX modes on Windows */ }
}

function withHostPorts(peer: AnnexPeer): AnnexPeer {
  // A typed address saved by an older build is this machine's own too (#3608).
  const typed = peer.typedHost ? parseTypedHost(peer.typedHost) : null;
  if (typed && !isPrivateHost(peer, typed.host)) peer = { ...peer, privateHosts: withPrivateHost(peer.privateHosts, typed.host) };
  if (!peer.knownHosts?.length) return peer;
  return { ...peer, hostPorts: hostPortsWithFallback(peer.knownHosts, peer.mainPort, peer.hostPorts) };
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function listPeers(): AnnexPeer[] {
  return [...loadPeers()];
}

/** Peers for Settings: each marked when it must be paired again before it can connect. */
export function listPeersForDisplay(): AnnexPeerListing[] {
  return loadPeers().map((peer) => ({ ...peer, needsPairing: peerNeedsPairing(peer) }));
}

/** Display-only alias from existing memory; never loads credentials or emits changes. */
export function peekPeerAlias(fingerprint: string): string | undefined {
  const matches = cachedPeers?.filter((peer) => typeof peer.fingerprint === 'string' && peer.fingerprint.toLowerCase() === fingerprint.toLowerCase());
  return matches?.length === 1 && typeof matches[0].alias === 'string' ? matches[0].alias : undefined;
}

/** Only already established display metadata, never credential/store loading or pairing evidence. */
export interface PeerDisplayMetadata {
  alias: DisplayValue<string | null>;
  lastSeen: DisplayValue<string | null>;
}
export const PEER_DISPLAY_SCAN_LIMIT = 1024;

function peerDisplayProjection(fingerprint: string): DisplayValue<PeerDisplayMetadata> {
  const inputs = [{ field: 'Retained machine metadata', source: 'host-cache' as const, observedAt: Date.now() }];
  const unknown = <T>(reason?: 'invalid' | 'limit'): DisplayValue<T> => ({ state: 'unavailable', inputs, ...(reason && { reason }) });
  const known = <T>(value: T): DisplayValue<T> => ({ state: 'ok', value, inputs });
  if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > 256) return unknown('invalid');
  if (!cachedPeers) return unknown();
  // Refuse an incomplete uniqueness check; every examined row, including
  // nonmatches, counts. This does not bound the existing lifecycle cache heap.
  if (cachedPeers.length > PEER_DISPLAY_SCAN_LIMIT) return unknown('limit');
  const key = fingerprint.toLowerCase();
  let selected: AnnexPeer | undefined;
  for (const peer of cachedPeers) {
    if (!peer || typeof peer.fingerprint !== 'string' || peer.fingerprint.length > 256 || peer.fingerprint.toLowerCase() !== key) continue;
    if (selected) return unknown('invalid');
    selected = peer;
  }
  // Absence in memory is not proof that a machine has never been configured.
  if (!selected) return unknown();
  const alias = selected.alias === undefined || selected.alias === '' ? known(null)
    : typeof selected.alias !== 'string' ? unknown<string | null>('invalid')
    : selected.alias.length > 1024 ? unknown<string | null>('limit') : known(selected.alias);
  const lastSeen = selected.lastSeen === undefined || selected.lastSeen === '' ? known(null)
    : typeof selected.lastSeen !== 'string' ? unknown<string | null>('invalid')
    : selected.lastSeen.length > 128 ? unknown<string | null>('limit')
    : Number.isFinite(Date.parse(selected.lastSeen)) ? known(selected.lastSeen) : unknown<string | null>('invalid');
  return known({ alias, lastSeen });
}

function peerDisplaySignature(value: DisplayValue<PeerDisplayMetadata>): string {
  const field = <T>(value: DisplayValue<T>) => ({ state: value.state, ...(value.state === 'ok' ? { value: value.value } : { reason: value.reason }) });
  return JSON.stringify({ ...field(value), ...(value.state === 'ok' && { value: { alias: field(value.value.alias), lastSeen: field(value.value.lastSeen) } }) });
}

/** Separate closure scope keeps only a selected key and bounded safe signature,
 * never a peer object, certificates, raw cache or unrelated machine records. */
function peerDisplayReceipt(fingerprint: string, signature: string): DisplayReceipt {
  return { current: () => { try { return peerDisplaySignature(peerDisplayProjection(fingerprint)) === signature; } catch { return false; } } };
}
export function readPeerMetadataForDisplay(fingerprint: string, options: { receipts?: DisplayReceipt[] } = {}): DisplayValue<PeerDisplayMetadata> {
  const value = peerDisplayProjection(fingerprint);
  if (typeof fingerprint === 'string' && fingerprint.length > 0 && fingerprint.length <= 256) options.receipts?.push(peerDisplayReceipt(fingerprint, peerDisplaySignature(value)));
  return value;
}

export function getPeer(fingerprint: string): AnnexPeer | undefined {
  return loadPeers().find((p) => p.fingerprint === fingerprint);
}

export function isPairedPeer(fingerprint: string): boolean {
  return loadPeers().some((p) => p.fingerprint === fingerprint);
}

/**
 * Whether this entry can't be used until it's paired again: it predates
 * certificate pinning (no pin, or no role), or, for a satellite, we never
 * stored its certificate. Such entries stay listed so they can be shown and removed.
 */
export function peerNeedsPairing(peer: AnnexPeer): boolean {
  if (!peer.role || !peer.tlsCertificateFingerprint) return true;
  return controlledFromHere(peer) && !peer.tlsCertificatePem;
}

/** It may control this machine: a controller, or a fellow network member (#3061). */
export function controlsThisMachine(peer: Pick<AnnexPeer, 'role' | 'networkPending'> | undefined | null): boolean {
  return !peer?.networkPending && (peer?.role === 'controller' || peer?.role === 'member');
}

/** This machine connects to it: a satellite, or a fellow network member that's a computer (#3061, #3062). */
export function controlledFromHere(peer: Pick<AnnexPeer, 'role' | 'kind'> | undefined | null): boolean {
  return peer?.role === 'satellite' || (peer?.role === 'member' && peer.kind !== 'phone');
}

export function addPeer(peer: AnnexPeer): void {
  peer = withHostPorts(peer);
  const peers = loadPeers();
  const existing = peers.findIndex((p) => p.fingerprint === peer.fingerprint);
  if (existing !== -1) {
    // Update existing peer
    peers[existing] = peer;
  } else {
    peers.push(peer);
  }
  savePeers(peers);
  appLog('core:annex', 'info', 'Peer added/updated', {
    meta: { fingerprint: peer.fingerprint, alias: peer.alias },
  });
}

export function removePeer(fingerprint: string): boolean {
  const peers = loadPeers();
  const idx = peers.findIndex((p) => p.fingerprint === fingerprint);
  if (idx === -1) return false;
  peers.splice(idx, 1);
  savePeers(peers);
  appLog('core:annex', 'info', 'Peer removed', { meta: { fingerprint } });
  return true;
}

export function removeAllPeers(): void {
  savePeers([]);
  appLog('core:annex', 'info', 'All peers removed');
}

/**
 * Remembers where a satellite was just reached (#3058): the host goes first in
 * its known hosts, and the port is kept, so it can be found after a restart.
 */
export function noteReached(fingerprint: string, host: string, port: number, from?: 'discovered'): void {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (!peer || !host || !(port > 0)) return;
  // Announced on the network by the device itself: shared at that port, even if the host was also typed (#3608).
  if (from === 'discovered' && !isAnnexLoopback(host)) peer.sharedEndpoints = { ...peer.sharedEndpoints, [host.toLowerCase()]: port };
  peer.hostPorts = { ...hostPortsWithFallback(peer.knownHosts, peer.mainPort, peer.hostPorts), [host.toLowerCase()]: port };
  peer.knownHosts = rememberHost(peer.knownHosts, host);
  // A route this machine saved for itself never becomes the shared default port (#3608).
  if (!peer.mainPort || !isPrivateHost(peer, host, port)) peer.mainPort = port;
  peer.lastSeen = new Date().toISOString();
  savePeers(peers);
}

/** Sets or clears (`undefined`) the host a person typed for a satellite. Returns whether the peer exists. */
export function setTypedHost(fingerprint: string, typedHost: string | undefined): boolean {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (!peer) return false;
  if (typedHost) {
    peer.typedHost = typedHost;
    const parsed = parseTypedHost(typedHost);
    if (parsed) peer.privateHosts = withPrivateHost(peer.privateHosts, parsed.host);
  } else {
    // Clearing forgets the address, but it stays private: it was this machine's own.
    delete peer.typedHost;
    delete peer.typedHostCert;
  }
  savePeers(peers);
  return true;
}

/** What a saved route is checked against (#3608): the peer's identity, pin and pairing. */
export interface PeerTrust {
  fingerprint: string;
  publicKey: string;
  role?: AnnexPeer['role'];
  tlsCertificateFingerprint?: string;
  tlsCertificatePem?: string;
  pairingId?: string;
  pairedAt: string;
  networkPending?: boolean;
}

export function trustOf(peer: AnnexPeer): PeerTrust {
  return {
    fingerprint: peer.fingerprint, publicKey: peer.publicKey, role: peer.role,
    tlsCertificateFingerprint: peer.tlsCertificateFingerprint, tlsCertificatePem: peer.tlsCertificatePem,
    pairingId: peer.pairingId, pairedAt: peer.pairedAt, networkPending: peer.networkPending,
  };
}

function sameTrust(a: PeerTrust, b: PeerTrust): boolean {
  return a.fingerprint === b.fingerprint && a.publicKey === b.publicKey && a.role === b.role
    && a.tlsCertificateFingerprint === b.tlsCertificateFingerprint && a.tlsCertificatePem === b.tlsCertificatePem
    && a.pairingId === b.pairingId && a.pairedAt === b.pairedAt && !!a.networkPending === !!b.networkPending;
}

/**
 * Saves a typed route checked against `expected` (#3608), only if the peer still
 * has exactly that identity, pin and pairing: compare and set, with nothing in
 * between. Returns false, changing nothing, when anything moved meanwhile.
 */
export function commitVerifiedRoute(fingerprint: string, expected: PeerTrust, typedHost: string, host: string): boolean {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (!peer || !sameTrust(trustOf(peer), expected) || !peer.tlsCertificateFingerprint) return false;
  peer.typedHost = typedHost;
  peer.typedHostCert = peer.tlsCertificateFingerprint;
  peer.privateHosts = withPrivateHost(peer.privateHosts, host);
  savePeers(peers);
  return true;
}

/**
 * The record pairing again writes (#3608), with this machine's saved routes from
 * `previous` carried over or held back, never dropped. They carry over only for
 * the same verified peer: the same identity, with certificate continuity shown
 * (the same pinned certificate, or a new one the identity key signed for). For
 * anything else they're held in `heldRoutes`, unused, until checked again, so a
 * saved forward is never pointed at a different peer.
 */
export function withSavedRoutes(previous: AnnexPeer | undefined, next: AnnexPeer, certContinuity: boolean): AnnexPeer {
  if (!previous) return next;
  // The privacy marker only ever narrows what's shared, so it always stays.
  const privateHosts = [...(next.privateHosts ?? [])];
  for (const host of previous.privateHosts ?? []) if (!privateHosts.includes(host)) privateHosts.push(host);
  const out: AnnexPeer = { ...next, ...(privateHosts.length && { privateHosts }) };
  const sameIdentity = previous.fingerprint === next.fingerprint && previous.publicKey === next.publicKey;
  const routes = { typedHost: previous.typedHost, knownHosts: previous.knownHosts, hostPorts: previous.hostPorts };
  const hasRoutes = !!routes.typedHost || !!routes.knownHosts?.length || !!Object.keys(routes.hostPorts ?? {}).length;
  if (sameIdentity && certContinuity) {
    // A bare typed host may rely only on this default; the server's pairing record has no port.
    if (!out.mainPort && previous.mainPort) out.mainPort = previous.mainPort;
    // This machine's own routes first, then what the new pairing says, then the rest it knew.
    const own = (previous.knownHosts ?? []).filter((h) => isPrivateHost(previous, h));
    out.knownHosts = [...new Set([...(next.knownHosts ?? []).slice(0, 1), ...own, ...(next.knownHosts ?? []), ...(previous.knownHosts ?? [])]
      .map((h) => h.toLowerCase()))].slice(0, KNOWN_HOSTS_MAX);
    // Ports are kept for every host, including any no longer listed; what the new pairing found wins.
    out.hostPorts = { ...hostPortsWithFallback(previous.knownHosts, previous.mainPort, previous.hostPorts), ...(next.hostPorts ?? {}) };
    if (!out.typedHost && previous.typedHost) {
      out.typedHost = previous.typedHost;
      if (previous.typedHostCert) out.typedHostCert = previous.typedHostCert;
    }
    if (!out.announcedReach && previous.announcedReach) out.announcedReach = previous.announcedReach;
    // Endpoints the device gave, host and port together: the new pairing's win for a host it also lists.
    const shared = { ...(previous.sharedEndpoints ?? {}), ...(next.sharedEndpoints ?? {}) };
    if (Object.keys(shared).length) out.sharedEndpoints = shared;
    if (previous.heldRoutes && !out.heldRoutes) out.heldRoutes = previous.heldRoutes;
    return out;
  }
  if (!hasRoutes) return previous.heldRoutes && !out.heldRoutes ? { ...out, heldRoutes: previous.heldRoutes } : out;
  // Held, not used. An older hold stays merged in, so nothing saved is lost.
  const older = previous.heldRoutes;
  // A bare typed host can depend on the old default even when it is not in knownHosts.
  // Keep that endpoint explicit in held evidence only; it has not been verified for the new pin.
  const typed = routes.typedHost ? parseTypedHost(routes.typedHost) : null;
  const typedPort = typed && routes.hostPorts && Object.prototype.hasOwnProperty.call(routes.hostPorts, typed.host)
    ? routes.hostPorts[typed.host] : previous.mainPort;
  const heldTypedHost = typed && typed.port === undefined && Number.isInteger(typedPort) && typedPort > 0 && typedPort <= 65535
    ? formatAddress({ host: typed.host, port: typedPort }) : routes.typedHost;
  const held: AnnexHeldRoutes = {
    certFingerprint: previous.tlsCertificateFingerprint ?? older?.certFingerprint,
    heldAt: new Date().toISOString(),
    ...((heldTypedHost ?? older?.typedHost) && { typedHost: heldTypedHost ?? older?.typedHost }),
    knownHosts: [...new Set([...(routes.knownHosts ?? []), ...(older?.knownHosts ?? [])])],
    hostPorts: { ...(older?.hostPorts ?? {}), ...hostPortsWithFallback(routes.knownHosts, previous.mainPort, routes.hostPorts) },
  };
  delete out.typedHost;
  delete out.typedHostCert;
  return { ...out, heldRoutes: held };
}

/**
 * Records when the connection to a peer was last confirmed alive (#3349), so a
 * long-lived connection's last seen isn't the time it opened. Never moves backwards.
 */
export function recordLastSeen(fingerprint: string, at: Date): void {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint.toLowerCase() === fingerprint.toLowerCase());
  if (!peer) return;
  const known = Date.parse(peer.lastSeen);
  if (Number.isFinite(known) && known >= at.getTime()) return;
  peer.lastSeen = at.toISOString();
  savePeers(peers, 'last-seen');
}

export function updateLastSeen(fingerprint: string): void {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (peer) {
    peer.lastSeen = new Date().toISOString();
    savePeers(peers, 'last-seen');
  }
}

// ---------------------------------------------------------------------------
// Brute-force protection
// ---------------------------------------------------------------------------

export interface BruteForceCheckResult {
  allowed: boolean;
  delayMs: number;
  locked: boolean;
  attemptsRemaining: number;
}

/**
 * Check whether a pairing attempt from `source` is allowed.
 * Returns the delay before the attempt should proceed, or locks out entirely.
 */
export function checkBruteForce(source: string): BruteForceCheckResult {
  const now = Date.now();
  const entry = bruteForceState.get(source);

  if (!entry) {
    return { allowed: true, delayMs: 0, locked: false, attemptsRemaining: MAX_FREE_ATTEMPTS };
  }

  // Check if locked out
  if (entry.attempts >= MAX_TOTAL_ATTEMPTS) {
    if (entry.lockedUntil > now) {
      return { allowed: false, delayMs: 0, locked: true, attemptsRemaining: 0 };
    }
    // Lockout expired — reset
    bruteForceState.delete(source);
    return { allowed: true, delayMs: 0, locked: false, attemptsRemaining: MAX_FREE_ATTEMPTS };
  }

  // Free attempts
  if (entry.attempts < MAX_FREE_ATTEMPTS) {
    return { allowed: true, delayMs: 0, locked: false, attemptsRemaining: MAX_FREE_ATTEMPTS - entry.attempts };
  }

  // Delayed attempts (exponential backoff)
  const backoffIdx = entry.attempts - MAX_FREE_ATTEMPTS;
  const delayMs = BACKOFF_DELAYS_MS[Math.min(backoffIdx, BACKOFF_DELAYS_MS.length - 1)];
  const elapsed = now - entry.lastAttempt;

  if (elapsed >= delayMs) {
    return { allowed: true, delayMs: 0, locked: false, attemptsRemaining: MAX_TOTAL_ATTEMPTS - entry.attempts };
  }

  return { allowed: false, delayMs: delayMs - elapsed, locked: false, attemptsRemaining: MAX_TOTAL_ATTEMPTS - entry.attempts };
}

/**
 * Record a failed pairing attempt from `source`.
 */
export function recordFailedAttempt(source: string): void {
  const now = Date.now();
  const entry = bruteForceState.get(source) || { attempts: 0, lastAttempt: 0, lockedUntil: 0 };
  entry.attempts += 1;
  entry.lastAttempt = now;

  if (entry.attempts >= MAX_TOTAL_ATTEMPTS) {
    // Lock out for 5 minutes
    entry.lockedUntil = now + 5 * 60 * 1000;
    appLog('core:annex', 'warn', 'Pairing locked out', { meta: { source, attempts: entry.attempts } });
  }

  bruteForceState.set(source, entry);
}

/**
 * Takes back one attempt recorded for `source`, for an answer that wasn't a guess:
 * an expired or used PIN, or a device that is already paired. A real device
 * retrying with an old code shouldn't lock itself out.
 */
export function forgiveFailedAttempt(source: string): void {
  const entry = bruteForceState.get(source);
  if (!entry) return;
  entry.attempts -= 1;
  if (entry.attempts <= 0) { bruteForceState.delete(source); return; }
  if (entry.attempts < MAX_TOTAL_ATTEMPTS) entry.lockedUntil = 0;
}

/**
 * Record a successful pairing from `source`, resetting the brute-force counter.
 */
export function recordSuccessfulAttempt(source: string): void {
  bruteForceState.delete(source);
}

/**
 * Manually unlock a locked-out source.
 */
export function unlockPairing(source?: string): void {
  if (source) {
    bruteForceState.delete(source);
  } else {
    bruteForceState.clear();
  }
  appLog('core:annex', 'info', 'Pairing unlocked', { meta: { source: source || 'all' } });
}

/**
 * Check if any source is currently locked.
 */
export function isPairingLocked(): boolean {
  const now = Date.now();
  for (const entry of bruteForceState.values()) {
    if (entry.attempts >= MAX_TOTAL_ATTEMPTS && entry.lockedUntil > now) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function resetForTests(): void {
  cachedPeers = null;
  bruteForceState.clear();
}
