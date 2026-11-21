/**
 * Value rules for negotiated member names (#3720), with no runtime consumers yet.
 * Epochs, ordering stamps and content IDs are data, never authentication or grants.
 */
export interface MemberNameEpoch {
  fingerprint: string;
  joinedAt: number;
  pairingId?: string;
}
export interface MemberNamePayload extends MemberNameEpoch {
  name: string;
  at: number;
  by: string;
}
export interface MemberNameOrder {
  at: number;
  by: string;
  id: string;
}

const MAX_DATE = 8640000000000000;
const MAX_STAMP = 253402300799999;
const MAX_FUTURE_MS = 86400000;
const DOMAIN = 'Clubhouse/member-name/1\n';
const owns = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Capture only enumerable own data, once; raw getters/iterators are never read. */
function fields(raw: unknown, required: readonly string[], optional: readonly string[], exact: boolean): Record<string, unknown> | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const proto = Object.getPrototypeOf(raw);
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = exact ? Reflect.ownKeys(raw) : [...required, ...optional];
    if (exact && (keys.length < required.length || keys.length > required.length + optional.length)) return null;
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (!descriptor && !exact && optional.includes(key)) continue;
      if (!descriptor || !owns(descriptor, 'value') || descriptor.enumerable !== true) return null;
      captured[key] = descriptor.value;
    }
    return required.every(key => owns(captured, key)) ? captured : null;
  } catch {
    // Even reflection-thrown parser-shaped errors are only invalid value data here.
    return null;
  }
}

function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 47 && value.length <= 95
    && !/[^0-9a-f:]/.test(value) && /^[0-9a-f]{2}(?::[0-9a-f]{2}){15,31}$/.test(value);
}
function pairingId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 8 && value.length <= 64 && !/[^A-Za-z0-9-]/.test(value);
}
function dateInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= MAX_DATE;
}
function stamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_STAMP;
}
function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function trimPoint(code: number): boolean {
  return (code >= 0x0009 && code <= 0x000d) || code === 0x0020 || code === 0x00a0
    || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028
    || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}
function trimName(value: string): string {
  let start = 0, end = value.length;
  while (start < end && trimPoint(value.charCodeAt(start))) start++;
  while (end > start && trimPoint(value.charCodeAt(end - 1))) end--;
  return value.slice(start, end);
}

/** Local intent preparation only: fixed trim, no truncation or Unicode normalization. */
export function normalizeLocalMemberName(value: unknown): string | null {
  if (typeof value !== 'string' || !wellFormed(value)) return null;
  const name = trimName(value);
  return name.length >= 1 && name.length <= 200 ? name : null;
}
/** A received modern name must already satisfy the fixed trim rule. */
export function isMemberName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
    && wellFormed(value) && trimName(value) === value;
}

/** Read a strict payload, not a whole record/frame. No ID/hash or sender is verified. */
export function readMemberNamePayload(raw: unknown): MemberNamePayload | null {
  const captured = fields(raw, ['fingerprint', 'joinedAt', 'name', 'at', 'by'], ['pairingId'], true);
  if (!captured || !fingerprint(captured.fingerprint) || !dateInteger(captured.joinedAt)
    || !isMemberName(captured.name) || !stamp(captured.at) || !fingerprint(captured.by)
    || (owns(captured, 'pairingId') && !pairingId(captured.pairingId))) return null;
  return {
    fingerprint: captured.fingerprint, joinedAt: captured.joinedAt, name: captured.name,
    at: captured.at, by: captured.by,
    ...(typeof captured.pairingId === 'string' ? { pairingId: captured.pairingId } : {}),
  };
}

/** Six explicit UTF-8 byte-length-prefixed fields; no JSON/locale/platform newline encoding. */
export function encodeMemberNamePayload(raw: MemberNamePayload): Uint8Array {
  const payload = readMemberNamePayload(raw);
  if (!payload) throw new TypeError('Invalid member name payload.');
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(DOMAIN)];
  for (const value of [payload.fingerprint, String(payload.joinedAt), payload.pairingId ?? '',
    payload.name, String(payload.at), payload.by]) {
    const bytes = encoder.encode(value);
    chunks.push(encoder.encode(String(bytes.length) + ':'), bytes);
  }
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Compare only selected epoch scalars, allowing unrelated record fields. No membership authority. */
export function sameMemberNameEpoch(left: MemberNameEpoch, right: MemberNameEpoch): boolean {
  const a = fields(left, ['fingerprint', 'joinedAt'], ['pairingId'], false);
  const b = fields(right, ['fingerprint', 'joinedAt'], ['pairingId'], false);
  const valid = (value: Record<string, unknown> | null): boolean => !!value && fingerprint(value.fingerprint)
    && dateInteger(value.joinedAt) && (!owns(value, 'pairingId') || pairingId(value.pairingId));
  return valid(a) && valid(b) && a.fingerprint === b.fingerprint && a.joinedAt === b.joinedAt
    && owns(a, 'pairingId') === owns(b, 'pairingId') && a.pairingId === b.pairingId;
}

/** Total (at, by, id) order for already scoped records, not an authorship or epoch check. */
export function compareMemberNameOrder(left: MemberNameOrder, right: MemberNameOrder): -1 | 0 | 1 {
  const read = (raw: MemberNameOrder): MemberNameOrder => {
    const value = fields(raw, ['at', 'by', 'id'], [], false);
    if (!value || !stamp(value.at) || !fingerprint(value.by) || typeof value.id !== 'string'
      || value.id.length !== 64 || /[^0-9a-f]/.test(value.id)) throw new TypeError('Invalid member name order.');
    return { at: value.at, by: value.by, id: value.id };
  };
  const a = read(left), b = read(right);
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.by !== b.by) return a.by < b.by ? -1 : 1;
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

/** Pure reservation arithmetic: caller supplies wall time and durable maximum; nothing is persisted. */
export function nextMemberNameStamp(now: number, maximum: number): number {
  if (!dateInteger(now) || !Number.isInteger(maximum) || maximum < 0 || maximum > MAX_STAMP) {
    throw new RangeError('Member name clock out of range.');
  }
  const next = Math.max(now, maximum + 1);
  if (!stamp(next)) throw new RangeError('Member name clock out of range.');
  return next;
}
/** Incoming-only future-skew decision. Never revalidate accepted disk history with this check. */
export function remoteMemberNameStampAllowed(at: number, now: number): boolean {
  return stamp(at) && dateInteger(now) && at - now <= MAX_FUTURE_MS;
}
