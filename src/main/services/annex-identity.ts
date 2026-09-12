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
  fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  // Restrict permissions to owner-only (ignore errors on Windows)
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows doesn't support Unix permissions
  }
}

function isValidAnnexIdentity(value: unknown): value is AnnexIdentity {
  if (!value || typeof value !== 'object') return false;

  const identity = value as Record<string, unknown>;
  return typeof identity.publicKey === 'string'
    && typeof identity.privateKey === 'string'
    && typeof identity.fingerprint === 'string'
    && typeof identity.createdAt === 'string';
}

function backupCorruptedIdentity(filePath: string): void {
  const backupPath = `${filePath}.bak`;
  try {
    fs.copyFileSync(filePath, backupPath);
  } catch (error) {
    appLog('core:annex', 'warn', 'Failed to back up corrupted Annex identity file', {
      meta: {
        filePath,
        backupPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

/**
 * Load identity from disk, or return its status so corruption can be handled
 * separately from first-run initialization.
 */
function loadIdentity(): { status: 'missing' | 'corrupt' | 'valid'; identity: AnnexIdentity | null } {
  const filePath = getIdentityPath();

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!isValidAnnexIdentity(parsed)) {
      appLog('core:annex', 'error', 'Annex identity file is corrupted or incomplete; regenerating a new identity', {
        meta: { filePath, reason: 'missing-required-fields' },
      });
      return { status: 'corrupt', identity: null };
    }

    return { status: 'valid', identity: parsed };
  } catch (error) {
    if (!fs.existsSync(filePath)) {
      return { status: 'missing', identity: null };
    }

    appLog('core:annex', 'error', 'Annex identity file is corrupted or unreadable; regenerating a new identity', {
      meta: {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { status: 'corrupt', identity: null };
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

  const loadResult = loadIdentity();
  if (loadResult.status === 'valid' && loadResult.identity) {
    cachedIdentity = loadResult.identity;
    appLog('core:annex', 'info', 'Loaded existing Annex identity', {
      meta: { fingerprint: cachedIdentity.fingerprint },
    });
    return cachedIdentity;
  }

  // A corrupt file indicates the trust anchor was lost; preserve a backup and
  // notify the user so paired devices can be re-established.
  if (loadResult.status === 'corrupt') {
    const filePath = getIdentityPath();
    backupCorruptedIdentity(filePath);
    appLog('core:annex', 'error', 'Your device identity was reset - re-pair your devices');
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

  const loadResult = loadIdentity();
  cachedIdentity = loadResult.status === 'valid' ? loadResult.identity : null;
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
 * Delete the persisted identity file and clear the cache.
 * After this, a new identity will be generated on next getOrCreateIdentity().
 */
export function deleteIdentity(): void {
  cachedIdentity = null;
  try {
    fs.unlinkSync(getIdentityPath());
    appLog('core:annex', 'info', 'Annex identity deleted');
  } catch {
    // File may not exist
  }
}

/**
 * Reset cached identity (for testing only).
 */
export function resetForTests(): void {
  cachedIdentity = null;
}
