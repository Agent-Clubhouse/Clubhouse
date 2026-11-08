/**
 * The Annex Network channel (#3060): what one member may tell another about the
 * network, and nothing else.
 *
 * It carries membership only: who is in the network, joins, removals and
 * names. It never carries anything that controls a machine (no agents,
 * terminals, files, settings or permissions). A message that isn't exactly one
 * of these is refused, and the channel is closed.
 *
 * Every message is JSON text with `v` (the protocol version) and `type`.
 */

export const NETWORK_PROTOCOL_VERSION = 1;

/** The WebSocket path on the main TLS port. */
export const NETWORK_CHANNEL_PATH = '/network';

/** Largest message accepted, in bytes. A member list of 64 devices fits easily. */
export const NETWORK_MESSAGE_MAX_BYTES = 64 * 1024;

/** Most members a list may carry. One person's devices; this is a sanity bound. */
export const NETWORK_MEMBERS_MAX = 64;

/** Close code for a message that isn't membership, or isn't well formed. */
export const NETWORK_CLOSE_NOT_MEMBERSHIP = 4400;
/** Close code for a protocol version this machine doesn't speak. */
export const NETWORK_CLOSE_VERSION = 4426;

/** A device as the network knows it. Addresses are hints; the pinned certificate decides. */
export interface NetworkMember {
  /** Its identity fingerprint: the first 16 bytes of the SHA-256 of its public key, colon-separated hex. */
  fingerprint: string;
  /** Base64 Ed25519 public key (DER/SPKI). The fingerprint must be its hash. */
  publicKey: string;
  /** SHA-256 of its TLS certificate, colon-separated hex. */
  certFingerprint: string;
  name: string;
  icon: string;
  color: string;
  kind: 'desktop' | 'phone';
  /** Where it may be reached (hosts only), best first. */
  hosts: string[];
  /** Its main TLS port, when it runs a server. */
  port?: number;
  /** ISO time it joined, as the member that added it saw it. */
  joinedAt: string;
}

/** A removal, kept so a member that was off learns of it. */
export interface NetworkRemoval {
  fingerprint: string;
  /** ISO time it was removed. */
  removedAt: string;
}

export type NetworkMessage =
  /** First message each way: who is speaking. */
  | { v: 1; type: 'hello'; member: NetworkMember }
  /** Everything the sender knows: its members and the removals it has seen. */
  | { v: 1; type: 'members'; members: NetworkMember[]; removals: NetworkRemoval[] }
  | { v: 1; type: 'member-joined'; member: NetworkMember }
  | { v: 1; type: 'member-removed'; removal: NetworkRemoval }
  | { v: 1; type: 'member-renamed'; fingerprint: string; name: string; at: string };

export type NetworkMessageType = NetworkMessage['type'];

export const NETWORK_MESSAGE_TYPES: readonly NetworkMessageType[] = ['hello', 'members', 'member-joined', 'member-removed', 'member-renamed'];

export type ParseResult =
  | { ok: true; message: NetworkMessage }
  | { ok: false; reason: 'too-large' | 'not-json' | 'version' | 'not-membership' | 'malformed' };

const FINGERPRINT = /^[0-9a-f]{2}(:[0-9a-f]{2}){15,31}$/i;
const CERT_FINGERPRINT = /^[0-9a-f]{2}(:[0-9a-f]{2}){31}$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((k) => allowed.includes(k));
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

const MEMBER_KEYS = ['fingerprint', 'publicKey', 'certFingerprint', 'name', 'icon', 'color', 'kind', 'hosts', 'port', 'joinedAt'] as const;

function isMember(value: unknown): value is NetworkMember {
  if (!isObject(value) || !onlyKeys(value, MEMBER_KEYS)) return false;
  if (typeof value.fingerprint !== 'string' || !FINGERPRINT.test(value.fingerprint)) return false;
  if (!isText(value.publicKey, 512)) return false;
  if (typeof value.certFingerprint !== 'string' || !CERT_FINGERPRINT.test(value.certFingerprint)) return false;
  if (!isText(value.name, 200) || !isText(value.icon, 64) || !isText(value.color, 64)) return false;
  if (value.kind !== 'desktop' && value.kind !== 'phone') return false;
  if (!Array.isArray(value.hosts) || value.hosts.length > 8 || !value.hosts.every((h) => isText(h, 255))) return false;
  if (value.port !== undefined && (!Number.isInteger(value.port) || (value.port as number) <= 0 || (value.port as number) > 65535)) return false;
  return isTime(value.joinedAt);
}

function isRemoval(value: unknown): value is NetworkRemoval {
  return isObject(value) && onlyKeys(value, ['fingerprint', 'removedAt'])
    && typeof value.fingerprint === 'string' && FINGERPRINT.test(value.fingerprint) && isTime(value.removedAt);
}

/**
 * Reads one channel message. Anything that isn't exactly a membership message
 * of this version is refused: unknown types, extra fields, wrong shapes.
 */
export function parseNetworkMessage(raw: string | Buffer): ParseResult {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length;
  if (size > NETWORK_MESSAGE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  let data: unknown;
  try { data = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return { ok: false, reason: 'not-json' }; }
  if (!isObject(data)) return { ok: false, reason: 'malformed' };
  if (!NETWORK_MESSAGE_TYPES.includes(data.type as NetworkMessageType)) return { ok: false, reason: 'not-membership' };
  if (data.v !== NETWORK_PROTOCOL_VERSION) return { ok: false, reason: 'version' };

  switch (data.type) {
    case 'hello':
    case 'member-joined':
      return onlyKeys(data, ['v', 'type', 'member']) && isMember(data.member)
        ? { ok: true, message: data as NetworkMessage } : { ok: false, reason: 'malformed' };
    case 'members':
      return onlyKeys(data, ['v', 'type', 'members', 'removals'])
        && Array.isArray(data.members) && data.members.length <= NETWORK_MEMBERS_MAX && data.members.every(isMember)
        && Array.isArray(data.removals) && data.removals.length <= NETWORK_MEMBERS_MAX * 4 && data.removals.every(isRemoval)
        ? { ok: true, message: data as NetworkMessage } : { ok: false, reason: 'malformed' };
    case 'member-removed':
      return onlyKeys(data, ['v', 'type', 'removal']) && isRemoval(data.removal)
        ? { ok: true, message: data as NetworkMessage } : { ok: false, reason: 'malformed' };
    case 'member-renamed':
      return onlyKeys(data, ['v', 'type', 'fingerprint', 'name', 'at'])
        && typeof data.fingerprint === 'string' && FINGERPRINT.test(data.fingerprint) && isText(data.name, 200) && isTime(data.at)
        ? { ok: true, message: data as NetworkMessage } : { ok: false, reason: 'malformed' };
    default:
      return { ok: false, reason: 'not-membership' };
  }
}
