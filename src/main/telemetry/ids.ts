/**
 * Identifier hashing (spec §5.2). `*.id_hash` attributes are
 * HMAC-SHA256(salt, rawId) truncated to 16 hex characters. Applied only to
 * opaque internal ids, never to names or paths.
 */
import { createHmac, randomBytes, randomUUID } from 'crypto';

export const HASH_HEX_LENGTH = 16;

export function hashId(salt: Buffer, rawId: string): string {
  return createHmac('sha256', salt).update(rawId, 'utf8').digest('hex').slice(0, HASH_HEX_LENGTH);
}

export interface TelemetryIdentity {
  /** Random v4 UUID, exported as `clubhouse.install.id`. */
  installId: string;
  /** 32 random bytes, base64. Never exported. */
  hashSalt: string;
}

/** A fresh install id and salt. Reset always rotates both together. */
export function createIdentity(): TelemetryIdentity {
  return { installId: randomUUID(), hashSalt: randomBytes(32).toString('base64') };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidIdentity(id: Partial<TelemetryIdentity> | undefined): id is TelemetryIdentity {
  if (!id || typeof id.installId !== 'string' || typeof id.hashSalt !== 'string') return false;
  return UUID_RE.test(id.installId) && Buffer.from(id.hashSalt, 'base64').length === 32;
}
