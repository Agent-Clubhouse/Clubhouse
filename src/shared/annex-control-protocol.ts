/**
 * The Annex control connection (#3613 P3): a desktop-only WebSocket that lets
 * the computer that accepted it send requests back to the computer that opened
 * it, over the route the opener already has.
 *
 * - Served at `/control` on the main TLS port, beside `/ws` and `/network`.
 *   Only an active desktop member of the network opens it or has it accepted.
 *   `/ws`, the phone contract and the membership channel are unchanged.
 * - The opener speaks first with `hello`, listing the features it supports. The
 *   other side sends nothing until then, and answers with the features both
 *   support. Nothing outside that set is ever sent, so an older peer (which
 *   never opens or accepts this path) gets nothing new. Negotiated per
 *   connection, never remembered.
 * - Only the accepting side sends `request`, `cancel`, `subscribe`,
 *   `unsubscribe` and `client`; only the opener sends `response`, `error`, `event` and
 *   `ended`. The opener (the target) authorizes every request and every
 *   subscribed frame itself, exactly as if the requester had connected to it
 *   directly.
 *
 * Every frame is JSON text with `v` (the protocol version) and `type`.
 */

export const CONTROL_PROTOCOL_VERSION = 1;

/** The WebSocket path on the main TLS port. */
export const CONTROL_CHANNEL_PATH = '/control';

/**
 * Largest frame either side sends or accepts, in bytes: the same as the
 * largest `/ws` frame. A request or response that doesn't fit is refused here;
 * chunked bodies are a later slice (P6).
 */
export const CONTROL_FRAME_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Largest `event` frame (a subscription's /ws frame plus its envelope): a /ws
 * frame, a snapshot included, can be a full 8 MiB. The socket accepts frames up
 * to this; requests and responses stay within CONTROL_FRAME_MAX_BYTES.
 */
export const CONTROL_EVENT_FRAME_MAX_BYTES = CONTROL_FRAME_MAX_BYTES + 64 * 1024;

/**
 * Features a peer may offer in its hello. Unknown names are ignored, so later slices add to this.
 * - `request`: reverse request/response (P3).
 * - `subscribe`: a reverse subscription to the target's /ws event stream (P4).
 * - `ws-control`: with a subscription, the subscriber sends /ws control frames
 *   (terminals, agent lifecycle, canvas, clipboard image) to it (P5).
 */
export const CONTROL_FEATURES = ['request', 'subscribe', 'ws-control'] as const;

/**
 * The /ws client frames a subscriber may send over `ws-control` (P5): the /ws
 * control set, nothing else. Each goes to the same /ws handler as on a direct
 * socket, for the subscription's virtual client.
 */
export const CONTROL_WS_CLIENT_TYPES = [
  'pty:input', 'pty:resize', 'pty:spawn-shell', 'pty:close', 'pty:attach',
  'agent:spawn', 'agent:wake', 'agent:kill', 'agent:reorder', 'canvas:mutation', 'clipboard:image',
] as const;
export type ControlFeature = typeof CONTROL_FEATURES[number];

/** Close code for a frame that breaks the protocol (wrong sender, malformed, unexpected). */
export const CONTROL_CLOSE_PROTOCOL = 4400;
/** Close code when the other side is no longer allowed to use this connection (removed, re-pinned, no longer a member). */
export const CONTROL_CLOSE_REVOKED = 4401;
/** Close code when the other side leaves too much unread: its answers would pile up here without bound. */
export const CONTROL_CLOSE_BACKLOG = 4429;
/** Close code for a protocol version this machine doesn't speak. */
export const CONTROL_CLOSE_VERSION = 4426;

/** Request methods carried. Each goes to the same route table as a direct request. */
export const CONTROL_METHODS = ['GET', 'POST', 'PATCH', 'DELETE'] as const;
export type ControlMethod = typeof CONTROL_METHODS[number];

/** Request headers carried to the route handler; any other name is refused. */
export const CONTROL_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'traceparent'] as const;

/** Request ids: chosen by the requester, unique among its requests, reused only to retry the same request. */
export const CONTROL_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

const PATH_MAX = 4096;

export type ControlEncoding = 'utf8' | 'base64';

/**
 * Why a request has no response. `indeterminate` (on the requester's error,
 * not on the wire) says whether the target may have acted.
 */
export type ControlErrorCode =
  /** No usable control connection to that computer, or it closed. */
  | 'transport_unavailable'
  /** The other side didn't agree to the feature. */
  | 'not_supported'
  | 'timeout'
  | 'cancelled'
  /** The requester was removed, re-pinned or is no longer allowed. */
  | 'authorization_revoked'
  /** Too many requests in flight on this connection. */
  | 'busy'
  | 'invalid_request'
  /** That id is already in flight on this connection. */
  | 'duplicate_id'
  | 'request_too_large'
  | 'response_too_large'
  /** A retry of a request that already finished, whose answer was too large to keep. It is not run again. */
  | 'replay_unavailable'
  /** This computer isn't serving Annex right now. */
  | 'unavailable';

/** Why a subscription ended. */
export type ControlEndCode =
  /** The subscriber lost access here (removed, re-pinned, no longer an active desktop member). */
  | 'authorization_revoked'
  /** The target stopped serving, or the subscription was closed there. */
  | 'closed'
  /** A /ws frame too large for this connection; the subscriber may subscribe again. */
  | 'frame_too_large';

export const CONTROL_END_CODES: readonly ControlEndCode[] = ['authorization_revoked', 'closed', 'frame_too_large'];

export const CONTROL_WIRE_ERRORS: readonly ControlErrorCode[] = [
  'not_supported', 'timeout', 'cancelled', 'authorization_revoked', 'busy', 'invalid_request', 'duplicate_id',
  'request_too_large', 'response_too_large', 'replay_unavailable', 'unavailable',
];

export interface ControlHttpRequest {
  method: ControlMethod;
  /** Path and query, as a direct request's URL. */
  path: string;
  headers?: Partial<Record<typeof CONTROL_REQUEST_HEADERS[number], string>>;
  body?: string;
  encoding?: ControlEncoding;
}

export interface ControlHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  encoding: ControlEncoding;
}

export type ControlMessage =
  /** First frame each way: the opener's offer, then the accepter's answer (a subset of it). */
  | { v: 1; type: 'hello'; features: string[] }
  /** Accepter → opener. */
  | ({ v: 1; type: 'request'; id: string } & ControlHttpRequest)
  /** Accepter → opener: stop working on a request. A no-op once it has finished. */
  | { v: 1; type: 'cancel'; id: string }
  /** Opener → accepter. */
  | ({ v: 1; type: 'response'; id: string } & ControlHttpResponse)
  /** Opener → accepter: the request (or subscribe) has no response. */
  | { v: 1; type: 'error'; id: string; code: ControlErrorCode }
  /** Accepter → opener: start receiving the opener's /ws stream, beginning with a fresh snapshot. One at a time per connection. */
  | { v: 1; type: 'subscribe'; id: string }
  /** Accepter → opener: stop it. A no-op once it has ended. */
  | { v: 1; type: 'unsubscribe'; id: string }
  /** Opener → accepter: one /ws frame, exactly as a /ws socket from the accepter would receive it. */
  | { v: 1; type: 'event'; id: string; frame: Record<string, unknown> }
  /** Opener → accepter: the subscription is over. */
  | { v: 1; type: 'ended'; id: string; code: ControlEndCode }
  /** Accepter → opener: one /ws client frame for the live subscription `id`'s virtual client (`ws-control`). */
  | { v: 1; type: 'client'; id: string; frame: Record<string, unknown> };

export type ControlParse =
  | { ok: true; message: ControlMessage }
  /** `id` is set when the frame is a request that can be answered with an error rather than closing. */
  | { ok: false; reason: 'json' | 'version' | 'shape'; detail: string; id?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && CONTROL_REQUEST_ID_PATTERN.test(value);
}

function validEncoding(value: unknown): value is ControlEncoding | undefined {
  return value === undefined || value === 'utf8' || value === 'base64';
}

function parseRequest(raw: Record<string, unknown>): ControlParse {
  const id = raw.id as string;
  const bad = (detail: string): ControlParse => ({ ok: false, reason: 'shape', detail, id });
  if (!(CONTROL_METHODS as readonly unknown[]).includes(raw.method)) return bad('method');
  const path = raw.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.length > PATH_MAX || /[\s#\\]/.test(path)) return bad('path');
  let headers: ControlHttpRequest['headers'];
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers)) return bad('headers');
    headers = {};
    for (const [name, value] of Object.entries(raw.headers)) {
      if (!(CONTROL_REQUEST_HEADERS as readonly string[]).includes(name) || typeof value !== 'string' || value.length > 1024 || /[\r\n]/.test(value)) return bad('headers');
      headers[name as typeof CONTROL_REQUEST_HEADERS[number]] = value;
    }
  }
  if (raw.body !== undefined && typeof raw.body !== 'string') return bad('body');
  if (!validEncoding(raw.encoding)) return bad('encoding');
  return {
    ok: true,
    message: {
      v: 1, type: 'request', id, method: raw.method as ControlMethod, path,
      ...(headers && { headers }), ...(raw.body !== undefined && { body: raw.body as string }), ...(raw.encoding !== undefined && { encoding: raw.encoding as ControlEncoding }),
    },
  };
}

/** Parses one text frame strictly. Anything that isn't exactly a control message is refused. */
export function parseControlMessage(text: string): ControlParse {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'json', detail: 'not JSON' }; }
  if (!isRecord(raw)) return { ok: false, reason: 'shape', detail: 'not an object' };
  if (raw.v !== CONTROL_PROTOCOL_VERSION) return { ok: false, reason: 'version', detail: String(raw.v) };
  switch (raw.type) {
    case 'hello':
      if (!Array.isArray(raw.features) || raw.features.length > 64 || !raw.features.every((f) => typeof f === 'string' && f.length <= 64)) {
        return { ok: false, reason: 'shape', detail: 'hello' };
      }
      return { ok: true, message: { v: 1, type: 'hello', features: raw.features as string[] } };
    case 'request':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      return parseRequest(raw);
    case 'cancel':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      return { ok: true, message: { v: 1, type: 'cancel', id: raw.id } };
    case 'response': {
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      const status = raw.status;
      if (typeof status !== 'number' || !Number.isInteger(status) || status < 100 || status > 599) return { ok: false, reason: 'shape', detail: 'status' };
      if (!isRecord(raw.headers) || !Object.values(raw.headers).every((v) => typeof v === 'string')) return { ok: false, reason: 'shape', detail: 'headers' };
      if (typeof raw.body !== 'string' || (raw.encoding !== 'utf8' && raw.encoding !== 'base64')) return { ok: false, reason: 'shape', detail: 'body' };
      return { ok: true, message: { v: 1, type: 'response', id: raw.id, status, headers: raw.headers as Record<string, string>, body: raw.body, encoding: raw.encoding } };
    }
    case 'error':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      if (!CONTROL_WIRE_ERRORS.includes(raw.code as ControlErrorCode)) return { ok: false, reason: 'shape', detail: 'code' };
      return { ok: true, message: { v: 1, type: 'error', id: raw.id, code: raw.code as ControlErrorCode } };
    case 'subscribe':
    case 'unsubscribe':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      return { ok: true, message: { v: 1, type: raw.type, id: raw.id } };
    case 'event':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      if (!isRecord(raw.frame) || typeof raw.frame.type !== 'string') return { ok: false, reason: 'shape', detail: 'frame' };
      return { ok: true, message: { v: 1, type: 'event', id: raw.id, frame: raw.frame } };
    case 'client':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      if (!isRecord(raw.frame) || typeof raw.frame.type !== 'string' || raw.frame.type.length > 64) return { ok: false, reason: 'shape', detail: 'frame' };
      return { ok: true, message: { v: 1, type: 'client', id: raw.id, frame: raw.frame } };
    case 'ended':
      if (!validId(raw.id)) return { ok: false, reason: 'shape', detail: 'id' };
      if (!CONTROL_END_CODES.includes(raw.code as ControlEndCode)) return { ok: false, reason: 'shape', detail: 'code' };
      return { ok: true, message: { v: 1, type: 'ended', id: raw.id, code: raw.code as ControlEndCode } };
    default:
      return { ok: false, reason: 'shape', detail: 'type' };
  }
}

/** A body as it goes on the wire: text when the bytes are valid UTF-8 (byte-for-byte), base64 otherwise. */
export function encodeControlBody(bytes: Buffer): { body: string; encoding: ControlEncoding } {
  const text = bytes.toString('utf8');
  return Buffer.byteLength(text) === bytes.length && Buffer.from(text, 'utf8').equals(bytes)
    ? { body: text, encoding: 'utf8' }
    : { body: bytes.toString('base64'), encoding: 'base64' };
}

export function decodeControlBody(body: string | undefined, encoding: ControlEncoding | undefined): Buffer {
  if (!body) return Buffer.alloc(0);
  return encoding === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

/** Requests that only read. They aren't deduplicated, and a lost answer to one is never indeterminate. */
export function isReadOnlyMethod(method: ControlMethod): boolean {
  return method === 'GET';
}
