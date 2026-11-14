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
import { devicesChanged } from './annex-device-signal';
import { hostPortsWithFallback, rememberHost } from './annex-reach';
import { isAnnexLoopback } from '../../shared/annex-problems';
import type { AnnexPeer, AnnexPeerListing } from '../../shared/types';

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

function savePeers(peers: AnnexPeer[]): void {
  const ephemeral = annexEphemeralSession();
  cachedPeers = peers;
  devicesChanged();
  if (ephemeral) return;
  // Readable by this user only: the file holds the certificates paired devices are trusted by.
  const target = getPeersPath();
  fs.writeFileSync(target, JSON.stringify(peers, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch { /* telemetry-exempt: no POSIX modes on Windows */ }
}

function withHostPorts(peer: AnnexPeer): AnnexPeer {
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
export function noteReached(fingerprint: string, host: string, port: number): void {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (!peer || !host || !(port > 0)) return;
  peer.hostPorts = { ...hostPortsWithFallback(peer.knownHosts, peer.mainPort, peer.hostPorts), [host.toLowerCase()]: port };
  peer.knownHosts = rememberHost(peer.knownHosts, host);
  if (!peer.mainPort || !isAnnexLoopback(host)) peer.mainPort = port;
  peer.lastSeen = new Date().toISOString();
  savePeers(peers);
}

/** Sets or clears (`undefined`) the host a person typed for a satellite. Returns whether the peer exists. */
export function setTypedHost(fingerprint: string, typedHost: string | undefined): boolean {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (!peer) return false;
  if (typedHost) peer.typedHost = typedHost;
  else delete peer.typedHost;
  savePeers(peers);
  return true;
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
  savePeers(peers);
}

export function updateLastSeen(fingerprint: string): void {
  const peers = loadPeers();
  const peer = peers.find((p) => p.fingerprint === fingerprint);
  if (peer) {
    peer.lastSeen = new Date().toISOString();
    savePeers(peers);
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
