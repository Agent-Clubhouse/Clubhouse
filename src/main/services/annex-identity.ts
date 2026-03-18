/**
 * Annex V2 Identity System (#859)
 *
 * Generates and persists a per-instance Ed25519 keypair for cryptographic
 * identity. The keypair is created lazily on first Annex enable and stored
 * in the userData directory. The fingerprint is a deterministic SHA-256 hash
 * of the public key, displayed as a colon-separated hex string.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { appLog } from './log-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnnexIdentity {
  /** Base64-encoded Ed25519 public key (DER/SPKI) */
  publicKey: string;
  /** Base64-encoded Ed25519 private key (DER/PKCS8) */
  privateKey: string;
  /** SHA-256 fingerprint of the public key, colon-separated hex */
  fingerprint: string;
  /** ISO timestamp of keypair creation */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_FILENAME = 'annex-identity.json';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let cachedIdentity: AnnexIdentity | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIdentityPath(): string {
  return path.join(app.getPath('userData'), IDENTITY_FILENAME);
}

/**
 * Compute a colon-separated SHA-256 fingerprint from a base64-encoded public key.
 */
export function computeFingerprint(publicKeyBase64: string): string {
  const hash = crypto.createHash('sha256').update(Buffer.from(publicKeyBase64, 'base64')).digest('hex');
  // Format as XX:XX:XX:... (first 32 hex chars = 16 bytes)
  return hash.slice(0, 32).match(/.{2}/g)!.join(':');
}

/**
 * Generate a new Ed25519 keypair and return an AnnexIdentity.
 */
function generateIdentity(): AnnexIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const publicKeyBase64 = publicKey.toString('base64');
  const privateKeyBase64 = privateKey.toString('base64');
  const fingerprint = computeFingerprint(publicKeyBase64);

  return {
    publicKey: publicKeyBase64,
    privateKey: privateKeyBase64,
    fingerprint,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Save identity to disk. Sets 0600 permissions on the file to protect the
 * private key (best-effort on platforms that support it).
 */
function saveIdentity(identity: AnnexIdentity): void {
  const filePath = getIdentityPath();
  fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf-8');

  // Restrict permissions to owner-only (ignore errors on Windows)
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows doesn't support Unix permissions
  }
}

/**
 * Load identity from disk, or return null if not found / corrupt.
 */
function loadIdentity(): AnnexIdentity | null {
  const filePath = getIdentityPath();
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (!parsed.publicKey || !parsed.privateKey || !parsed.fingerprint || !parsed.createdAt) {
      appLog('core:annex', 'warn', 'Identity file is missing required fields, regenerating');
      return null;
    }

    return parsed as AnnexIdentity;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get or create the Annex identity for this instance.
 *
 * On first call, generates an Ed25519 keypair and persists it to disk.
 * Subsequent calls return the cached identity.
 */
export function getOrCreateIdentity(): AnnexIdentity {
  if (cachedIdentity) return cachedIdentity;

  // Try loading from disk
  cachedIdentity = loadIdentity();
  if (cachedIdentity) {
    appLog('core:annex', 'info', 'Loaded existing Annex identity', {
      meta: { fingerprint: cachedIdentity.fingerprint },
    });
    return cachedIdentity;
  }

  // Generate new identity
  cachedIdentity = generateIdentity();
  saveIdentity(cachedIdentity);
  appLog('core:annex', 'info', 'Generated new Annex identity', {
    meta: { fingerprint: cachedIdentity.fingerprint },
  });

  return cachedIdentity;
}

/**
 * Get the current identity without creating one. Returns null if no identity
 * has been generated yet.
 */
export function getIdentity(): AnnexIdentity | null {
  if (cachedIdentity) return cachedIdentity;
  cachedIdentity = loadIdentity();
  return cachedIdentity;
}

/**
 * Get the public identity info (safe to share over the network).
 * Returns null if no identity exists.
 */
export function getPublicIdentity(): { publicKey: string; fingerprint: string } | null {
  const identity = getIdentity();
  if (!identity) return null;
  return { publicKey: identity.publicKey, fingerprint: identity.fingerprint };
}

/**
 * Reset cached identity (for testing only).
 */
export function resetForTests(): void {
  cachedIdentity = null;
}
