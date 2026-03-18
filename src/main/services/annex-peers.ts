/**
 * Annex V2 Peer Management (#860)
 *
 * CRUD operations for paired peers, stored in ${userData}/annex-peers.json.
 * Includes brute-force protection for the pairing endpoint.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';
import type { AnnexPeer } from '../../shared/types';

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
  if (cachedPeers) return cachedPeers;

  try {
    const raw = fs.readFileSync(getPeersPath(), 'utf-8');
    cachedPeers = JSON.parse(raw) as AnnexPeer[];
    return cachedPeers;
  } catch {
    cachedPeers = [];
    return cachedPeers;
  }
}

function savePeers(peers: AnnexPeer[]): void {
  cachedPeers = peers;
  fs.writeFileSync(getPeersPath(), JSON.stringify(peers, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

export function listPeers(): AnnexPeer[] {
  return [...loadPeers()];
}

export function getPeer(fingerprint: string): AnnexPeer | undefined {
  return loadPeers().find((p) => p.fingerprint === fingerprint);
}

export function isPairedPeer(fingerprint: string): boolean {
  return loadPeers().some((p) => p.fingerprint === fingerprint);
}

export function addPeer(peer: AnnexPeer): void {
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
