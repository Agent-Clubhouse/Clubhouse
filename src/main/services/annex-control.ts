/**
 * The Annex control connection (#3613 P3). See `annex-control-protocol.ts`.
 *
 * Two ends of one connection, opened by the computer that has the route:
 * - `out`: this machine opened it. It is the **target**: the other side may
 *   send it requests, and it authorizes each one with the P1 authorizer as a
 *   `reverse` principal (the identity and certificate this connection
 *   verified), then runs it through the same route handlers as a direct
 *   request. The connection's direction never grants anything.
 * - `in`: this machine accepted it. It is the **requester**: `request()` sends
 *   to the computer that opened it.
 *
 * Request ids, a seen-cache on the target, cancellation and indeterminate
 * outcomes are here. The route table, the authorizer's lookups and the
 * acceptance check are injected by the server, so this module imports none of
 * them.
 *
 * P4 adds `subscribe`: the requester receives the target's /ws stream, served
 * by the server as a virtual /ws client and checked frame by frame. Later
 * slices add features to the hello (terminals, bulk transfers) and their own
 * lanes; P2's route abstraction calls `request()` for
 * a machine with no outbound route.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createHash, randomUUID } from 'crypto';
import * as net from 'net';
import * as tls from 'tls';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import {
  CONTROL_CHANNEL_PATH,
  CONTROL_CLOSE_BACKLOG,
  CONTROL_CLOSE_PROTOCOL,
  CONTROL_CLOSE_REVOKED,
  CONTROL_CLOSE_VERSION,
  CONTROL_EVENT_FRAME_MAX_BYTES,
  CONTROL_FEATURES,
  CONTROL_FRAME_MAX_BYTES,
  CONTROL_PROTOCOL_VERSION,
  CONTROL_WS_CLIENT_TYPES,
  decodeControlBody,
  encodeControlBody,
  isReadOnlyMethod,
  parseControlMessage,
  type ControlEndCode,
  type ControlErrorCode,
  type ControlFeature,
  type ControlHttpRequest,
  type ControlHttpResponse,
  type ControlMessage,
  type ControlMethod,
} from '../../shared/annex-control-protocol';
import { isRefusal, type AnnexAuthResult, type AnnexCaller, type AnnexPrincipal } from './annex-authorizer';
import * as annexTls from './annex-tls';
import { appLog } from './log-service';
import { CLIPBOARD_IMAGE_MAX_BASE64, MOBILE_CONTENT_MAX_BASE64 } from '../../shared/annex-binary-limits';
import { ControlBulkLane, BULK_CHUNK_BYTES, type BulkKind } from './annex-control-bulk';
import { CHAT_IMAGE_MAX_BYTES } from '../../shared/chat';
import { FULL_EVENT_MAX_BYTES } from './annex-full-events';
import { HANDOFF_TRANSFER_BODY_BYTES } from '../../shared/handoff-transfer';
import { ICON_SERVED_MAX_BYTES } from '../../shared/icon-limits';
import { routeAllowed, type AnnexRoute } from './annex-routes';
import { classifyConnectionError } from '../../shared/annex-problems';
import { devicesChanged } from './annex-device-signal';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** How long a connection may stay silent before its hello, before it's closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** A ping this often; no pong by the next one and the connection is dead. */
export const HEARTBEAT_MS = 30_000;
/** Reconnect backoff has a hard final cap, including jitter. */
export const RECONNECT_MAX_MS = 30_000;
/** An old server may reset an unknown upgrade path without an HTTP refusal. */
const UNKNOWN_PEER_PROBE_MS = 10 * 60_000;
const UNKNOWN_PEER_RESET_LIMIT = 6;
/** Request timeout, refreshed by progress on its bulk body as with a direct REST call. */
export const REQUEST_TIMEOUT_MS = 30_000;
/**
 * Longest a target lets one request run (the same bound as a direct request on
 * the main port). At this point the requester is told `timeout` and the
 * handler's response is cut off.
 */
export const TARGET_TIMEOUT_MS = 60_000;
/**
 * Requests a target runs at once for one requester, across its connections,
 * counting runs whose requester has stopped waiting but whose handler hasn't
 * finished. A slot frees only when the handler's run settles. Also the most
 * answers one connection may have outstanding (not yet written). More are
 * answered `busy`.
 */
export const MAX_IN_FLIGHT = 16;
/**
 * Most bytes a connection may have queued to send but not yet written: the
 * other side isn't reading. Over this the connection closes (4429) rather than
 * buffer without bound or drop a frame. Two full frames.
 */
export const CONTROL_SEND_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
/** Requests a requester has waiting on one connection. */
export const MAX_PENDING = 64;
/** How long a target remembers a finished non-read request, so a retry with its id gets the same answer. */
export const SEEN_TTL_MS = 10 * 60_000;
/**
 * Remembered requests per requester, running ones included. The oldest
 * finished one goes first; a running one is never dropped, so at the bound a
 * new non-read request is answered `busy`.
 */
export const SEEN_MAX_PER_PEER = 512;
/** Largest answer kept for a retry. A bigger one is remembered as finished, and a retry gets `replay_unavailable`. */
export const SEEN_RETAIN_MAX_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A response as a requester gets it. */
export interface ControlResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** A request with no response. `indeterminate`: it may have run on the target; it is never retried automatically. */
export class ControlRequestError extends Error {
  constructor(readonly code: ControlErrorCode, readonly indeterminate: boolean, readonly requestId: string) {
    super(indeterminate ? `${code}: the request may have been carried out` : code);
    this.name = 'ControlRequestError';
  }
}

export interface ControlRequestInput {
  method: ControlMethod;
  path: string;
  headers?: ControlHttpRequest['headers'];
  body?: Buffer | string;
}

export interface ControlRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Local receive limit, never sent to the target. */
  maxResponseBytes?: number;
  /** Reuse an earlier request's id to retry it: the target answers with the original outcome instead of running it again. */
  requestId?: string;
}

/** The server's answer to whether a peer may hold a control connection with this machine. */
export type InboundDecision = { ok: true; fingerprint: string; pin: string } | { ok: false; status: 401 | 403; error: string; message: string };

/** What the accepting side needs from the server. */
export interface InboundAuthority {
  /** May the peer on this TLS socket open a control connection here (a pinned, active desktop member). */
  accept(socket: unknown): InboundDecision;
  /** The same decision now, for the identity and certificate the connection was accepted with. */
  stillAllowed(fingerprint: string, pin: string): boolean;
}

/** What a target needs to run one request. */
export interface DispatchContext {
  remoteAddress: string | undefined;
  /** The requester stopped waiting (cancelled, or the connection went). The handler sees its request close; its answer is still kept if it finishes. */
  signal: AbortSignal;
  /** The run's time is up, or a cancelled read: the response is cut off and won't complete. */
  deadline: AbortSignal;
  /** The connection the request came over is still open. */
  linkOpen: () => boolean;
  /** Response envelope budget; files/read retains its existing uncapped body with bulk. */
  responseLimit?: number;
}

/** What the target side needs from the server: the authorizer and the route table. */
export interface ControlTarget {
  /** The P1 authorizer, for a caller that is always `via: 'reverse'`. */
  authorize(caller: AnnexCaller): AnnexAuthResult;
  /** Whether that principal is still authorized now. */
  stillAuthorized(principal: AnnexPrincipal): boolean;
  /** Runs a request already authorized as `principal` through the route table. */
  dispatch(principal: AnnexPrincipal, request: ControlHttpRequest, ctx: DispatchContext): Promise<DispatchResult>;
  /**
   * Starts a subscription for `principal` (P4): the server serves it the /ws
   * stream through `sink`, fresh snapshot first. Null if it can't now.
   * Absent on a target that serves none.
   */
  subscribe?(principal: AnnexPrincipal, sink: SubscriptionSink): SubscriptionHandle | null;
}

/** Where a target's subscription writes. The server's virtual /ws client calls it. */
export interface SubscriptionSink {
  /**
   * One /ws frame, already serialized. Checked against the subscriber's access
   * before it goes. False if it wasn't sent: the subscription is over, and the
   * caller closes its side.
   */
  send(frame: string): boolean;
  /** The server ended it (closed, revoked, stopping). */
  end(code: ControlEndCode): void;
}

/** The server's side of a subscription. */
export interface SubscriptionHandle {
  /** The subscriber left, or the connection went: stop serving it. */
  close(): void;
  /**
   * One /ws client frame from the subscriber (P5), already allowed and
   * authorized here: the server runs it through its /ws handler for the
   * subscription's virtual client, which checks it again.
   */
  receive?(frame: string): void;
}

/** What a subscriber hears. */
export interface SubscriptionHandlers {
  /** One /ws frame, exactly as a /ws socket to that computer would receive it. */
  onFrame(frame: Record<string, unknown>): void;
  /** It's over: ended there, refused, or the connection went. Called once; never after `close()`. */
  onEnd(code: ControlEndCode | ControlErrorCode): void;
}

/** A subscription this machine holds to another computer's stream. */
export interface ControlSubscription {
  readonly id: string;
  /** Stop receiving. `onEnd` isn't called. */
  close(): void;
  /**
   * Sends one /ws control frame (`pty:*`, `agent:*`, `canvas:mutation`,
   * `clipboard:image`) as a /ws socket to that computer would. Its answers
   * arrive as frames. False if it can't go: the other side didn't agree to
   * `ws-control`, the type isn't one of those, or the subscription is over.
   */
  send(frame: { type: string; payload?: Record<string, unknown>; tc?: string }): boolean;
}

/** Target: the subscription a connection is being served. */
interface ServedSubscription {
  id: string;
  handle: SubscriptionHandle | null;
  ended: boolean;
  principal: AnnexPrincipal;
  sink: SubscriptionSink;
}

/** A handler's response. `complete`: it ended its response; anything else is never sent or remembered as an answer. */
export interface DispatchResult extends ControlResult {
  complete: boolean;
  /**
   * Settles when the route's own work does, which can be after its response
   * (one cut off at the deadline while its operation still runs). The
   * requester's slot is held until then.
   */
  operations?: Promise<void>;
}

interface Pending {
  id: string;
  method: ControlMethod;
  path: string;
  maxResponseBytes?: number;
  resolve: (result: ControlResult) => void;
  reject: (err: ControlRequestError) => void;
  cleanup: () => void;
  progress: () => void;
}

interface Link {
  bulk: ControlBulkLane;
  ws: WebSocket;
  /** The other side's identity. */
  fingerprint: string;
  /** The certificate it presented on this connection. */
  pin: string;
  /** `out`: opened here, this machine is the target. `in`: accepted here, this machine requests. */
  direction: 'in' | 'out';
  remoteAddress: string | undefined;
  /** Agreed features; null until the hellos are exchanged. */
  features: Set<ControlFeature> | null;
  announcedReady: boolean;
  requestEpoch: number;
  /** What the opener offered in its hello (`out` only). */
  offered: Set<string> | null;
  closed: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  alive: boolean;
  pending: Map<string, Pending>;
  /** Requester: subscriptions this machine holds over this connection (at most one). */
  subscriptions: Map<string, SubscriptionHandlers>;
  /** Target: the subscription this connection is being served, if any. */
  subscription: ServedSubscription | null;
  /** Target: requests this connection is owed an answer for, until it is written. Aborted on cancel or close. */
  replying: Map<string, AbortController>;
  onReady?: () => void;
}

export interface ControlConnectionPlan {
  fingerprint: string;
  pin: string;
  /** Opaque identity/pin/pairing snapshot, not route freshness or a wire field. */
  trust: string;
  localFingerprint: string;
  routes: readonly AnnexRoute[];
  tlsOptions(): tls.ConnectionOptions;
}

export interface ControlConnectionSource {
  plans(): readonly ControlConnectionPlan[];
  autoReconnect(): boolean;
}

interface KeptConnection {
  plan: ControlConnectionPlan;
  routeKey: string;
  attempt: number;
  nextRoute: number;
  started: boolean;
  blocked?: 'stopped' | 'revoked' | 'pin' | 'unsupported';
  timer: ReturnType<typeof setTimeout> | null;
  socket: WebSocket | null;
  route: AnnexRoute | null;
  readyAt: number | null;
  resetFailures: number;
  everReady: boolean;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const links = new Set<Link>();
let nextLinkEpoch = 0;
let inboundAuthority: InboundAuthority | null = null;
let target: ControlTarget | null = null;
let wss: WebSocketServer | null = null;
let connectionSource: ControlConnectionSource | null = null;
const keptConnections = new Map<string, KeptConnection>();
const outgoingSockets = new Map<string, WebSocket>();
/**
 * Target: runs not yet settled, by requester (identity and certificate). Kept
 * apart from any connection, so closing or replacing one never frees a slot
 * whose handler is still running.
 */
const activeRuns = new Map<string, number>();

function runKey(principal: { fingerprint: string; pin: string }): string {
  return `${principal.fingerprint}\n${principal.pin}`;
}
let targetTimeoutMs = TARGET_TIMEOUT_MS;

/** The server sets this while it runs; without it nothing is accepted. */
export function setInboundAuthority(authority: InboundAuthority | null): void {
  inboundAuthority = authority;
  if (!authority) closeAll('in');
}

/**
 * The server sets this while it runs; without it this machine opens no control
 * connection and runs no request. Stopping also forgets every remembered
 * request: a retry after the server restarts is answered afresh.
 */
export function setControlTarget(next: ControlTarget | null): void {
  target = next;
  if (!next) {
    closeAll('out');
    seen.clear();
  } else {
    refreshConnections();
  }
}

/** Whether this machine can be a target now (its server is running). */
export function canServe(): boolean {
  return target !== null;
}

// ---------------------------------------------------------------------------
// Seen-cache (target)
// ---------------------------------------------------------------------------

/**
 * A finished request as the target remembers it. `not_retained`: it ran, or may
 * have, but there's no answer to replay: too large to keep, or its handler
 * never completed a response (timed out, cut off, failed). A retry gets
 * `replay_unavailable`, never a made-up answer and never a second run.
 */
type Stored = { kind: 'response'; response: ControlResult } | { kind: 'not_retained' } | { kind: 'error'; code: ControlErrorCode };

interface SeenEntry {
  peer: string;
  digest: string;
  at: number;
  done: Stored | null;
  settled: Promise<Stored>;
}

/**
 * What a target remembers about non-read requests it ran, by requester (identity
 * and certificate) and request id. A retry with the same id and the same request
 * gets the original answer, waiting for it if it's still running. The same id
 * with a different request is a conflict. A new pin starts over.
 */
export class SeenCache {
  private readonly entries = new Map<string, SeenEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  static key(principal: { fingerprint: string; pin: string }, id: string): string {
    return `${principal.fingerprint}\n${principal.pin}\n${id}`;
  }

  private prune(): void {
    const cutoff = this.now() - SEEN_TTL_MS;
    for (const [key, entry] of this.entries) if (entry.done && entry.at < cutoff) this.entries.delete(key);
  }

  /** Without changing anything: `same` (wait for or replay it), `conflict` (another request under that id) or `absent`. */
  peek(key: string, digest: string): { kind: 'same'; settled: Promise<Stored> } | { kind: 'conflict' } | { kind: 'absent' } {
    this.prune();
    const existing = this.entries.get(key);
    if (!existing) return { kind: 'absent' };
    return existing.digest === digest ? { kind: 'same', settled: existing.settled } : { kind: 'conflict' };
  }

  /**
   * `new`: run it and call `finish`. `same` / `conflict` as `peek`. `full`: the
   * requester already has the most remembered requests and none has finished.
   */
  begin(key: string, peer: string, digest: string): { kind: 'new'; finish: (stored: Stored) => void } | { kind: 'same'; settled: Promise<Stored> } | { kind: 'conflict' } | { kind: 'full' } {
    const known = this.peek(key, digest);
    if (known.kind !== 'absent') return known;
    if (!this.makeRoom(peer)) return { kind: 'full' };
    let finish!: (stored: Stored) => void;
    const settled = new Promise<Stored>((resolve) => { finish = resolve; });
    const entry: SeenEntry = { peer, digest, at: this.now(), done: null, settled };
    this.entries.set(key, entry);
    return {
      kind: 'new',
      finish: (stored) => {
        if (entry.done) return;
        entry.done = stored;
        entry.at = this.now();
        finish(stored);
      },
    };
  }

  /** Room for one more of `peer`'s: drops its oldest finished entry if it must. Never a running one. */
  private makeRoom(peer: string): boolean {
    const mine = [...this.entries].filter(([, e]) => e.peer === peer);
    if (mine.length < SEEN_MAX_PER_PEER) return true;
    const oldest = mine.filter(([, e]) => e.done).sort(([, a], [, b]) => a.at - b.at)[0];
    if (!oldest) return false;
    this.entries.delete(oldest[0]);
    return true;
  }

  forgetPeer(fingerprint: string): void {
    for (const [key, entry] of this.entries) if (entry.peer === fingerprint) this.entries.delete(key);
  }

  get size(): number { return this.entries.size; }

  clear(): void { this.entries.clear(); }
}

const seen = new SeenCache();

function requestDigest(request: ControlHttpRequest): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([request.method, request.path, request.headers?.['content-type'] ?? '']));
  hash.update('\n');
  hash.update(decodeControlBody(request.body, request.encoding));
  return hash.digest('hex');
}

/** Routes whose existing bodies belong on the bulk lane even when small. */
function binaryPath(path: string): boolean {
  return /\/(?:attachments|content|files\/read|handoffs\/transfer|icons\/|chat\/events\/)/.test(path);
}
function requestBodyLimit(path: string): number {
  return /^\/api\/v1\/mobile\/agents\/[^/]+\/attachments$/.test(path) ? CHAT_IMAGE_MAX_BYTES : CONTROL_FRAME_MAX_BYTES;
}
const GIT_DIFF_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;
/** Envelope limits only; route handlers retain their exact existing content limits. */
export function responseBodyLimit(path: string, method?: ControlMethod): number {
  if (method === 'GET' && /^\/api\/v1\/projects\/[^/?#]+\/git\/diff(?:\?[^#]*)?$/.test(path)) return GIT_DIFF_RESPONSE_MAX_BYTES;
  if (/^\/api\/v1\/projects\/[^/]+\/files\/read(?:\?|$)/.test(path)) return Infinity;
  if (/\/chat\/events\/\d+(?:\?|$)/.test(path)) return FULL_EVENT_MAX_BYTES;
  if (/\/icons\//.test(path)) return ICON_SERVED_MAX_BYTES;
  if (/\/handoffs\/transfer$/.test(path)) return HANDOFF_TRANSFER_BODY_BYTES;
  // The content route caps raw bytes at 8 MiB, then base64 encodes them.
  if (/\/content(?:\?|$)/.test(path)) return MOBILE_CONTENT_MAX_BASE64 + 64 * 1024;
  return CONTROL_FRAME_MAX_BYTES + 64 * 1024;
}
function bulkAllowed(link: Link): boolean {
  if (link.closed || !link.features?.has('bulk')) return false;
  if (link.ws.readyState !== WebSocket.OPEN) { closeLink(link, 1000, 'closed'); return false; }
  if (link.direction === 'in') return inboundStillAllowed(link);
  if (target?.authorize({ fingerprint: link.fingerprint, pin: link.pin, via: 'reverse' }).ok) return true;
  refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'revoked during bulk'); return false;
}
function bulkMeta(kind: BulkKind, id: string, meta: Record<string, unknown>): ControlMessage | null {
  const parsed = parseControlMessage(JSON.stringify({ ...meta, v: 1, type: kind, id,
    ...(kind === 'response' && { body: '', encoding: 'utf8' }),
  }));
  return parsed.ok ? parsed.message : null;
}
let bulkTokenLimitForTests: number | undefined;
function makeBulkLane(link: Link): ControlBulkLane {
  return new ControlBulkLane({
    allowed: () => bulkAllowed(link),
    accept: (kind, id, meta, size) => {
      const message = bulkMeta(kind, id, meta);
      if (!message || message.type !== kind) return false;
      if (kind === 'request' && message.type === 'request') return link.direction === 'out' && !!link.features?.has('request')
        && !link.replying.has(id) && size <= requestBodyLimit(message.path);
      if (kind === 'response') {
        const pending = link.pending.get(id);
        return link.direction === 'in' && !!pending && link.features!.has('request') && size <= responseBodyLimit(pending.path, pending.method)
          && (pending.maxResponseBytes === undefined || size <= pending.maxResponseBytes);
      }
      if (kind === 'client' && message.type === 'client') return link.direction === 'out' && !!link.features?.has('ws-control')
        && link.subscription?.id === id && !link.subscription.ended && message.frame.type === 'clipboard:image'
        && size <= CLIPBOARD_IMAGE_MAX_BASE64 && typeof message.frame.payload === 'object' && message.frame.payload !== null;
      return false;
    },
    rejectStart: (kind, id, meta, size) => {
      const message = bulkMeta(kind, id, meta);
      const pending = link.pending.get(id);
      if (kind === 'response' && message?.type === 'response' && link.direction === 'in' && link.features?.has('request')
        && pending && (size > responseBodyLimit(pending.path, pending.method)
          || (pending.maxResponseBytes !== undefined && size > pending.maxResponseBytes))) {
        link.pending.delete(id);
        pending.cleanup();
        pending.reject(new ControlRequestError('response_too_large', !isReadOnlyMethod(pending.method), id));
        return true;
      }
      if (link.direction !== 'out' || !link.features?.has('request') || link.replying.has(id) || message?.type !== 'request' || size <= requestBodyLimit(message.path) || !/\/attachments$/.test(message.path)) return false;
      return rawSend(link, { v: 1, type: 'response', id, ...toWire(jsonResponse(413, { version: 1, error: 'too_large' })) });
    },
    complete: (kind, id, meta, body) => {
      const message = bulkMeta(kind, id, meta);
      if (!message) return;
      if (message.type === 'request') { void onRequest(link, { ...message, ...encodeControlBody(body) }, true); return; }
      if (message.type === 'response') {
        const pending = link.pending.get(id);
        if (!pending) return;
        link.pending.delete(id); pending.cleanup(); pending.resolve({ status: message.status, headers: message.headers, body }); return;
      }
      if (message.type === 'client') {
        const payload = message.frame.payload as Record<string, unknown>;
        onClientFrame(link, { ...message, frame: { ...message.frame, payload: { ...payload, base64: body.toString('utf8') } } }, true);
      }
    },
    send: (frame, written) => rawSend(link, frame, written),
    binary: (bytes, written, stillOwned) => {
      if (!bulkAllowed(link) || link.ws.readyState !== WebSocket.OPEN) return false;
      // Hold at most one chunk per transfer while control/events drain; keep
      // their socket budget available and reauthorize at the actual send.
      const send = () => {
        if (!stillOwned() || !bulkAllowed(link) || link.ws.readyState !== WebSocket.OPEN) { written(); return; }
        if (link.ws.bufferedAmount + bytes.length > 2 * BULK_CHUNK_BYTES) {
          const timer = setTimeout(send, 10); timer.unref?.(); return;
        }
        try { link.ws.send(bytes, written); } catch { closeLink(link, 1001, 'write_failed'); }
      };
      send(); return true;
    },
    progress: (id) => link.pending.get(id)?.progress(),
    fail: () => refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'invalid bulk transfer'),
  }, bulkTokenLimitForTests);
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

function frameFits(message: ControlMessage): string | null {
  const text = JSON.stringify(message);
  return Buffer.byteLength(text) <= CONTROL_FRAME_MAX_BYTES ? text : null;
}

/**
 * Sends one frame. `onWritten` runs once it has been written out, or at once if
 * it can't be sent. A connection whose unwritten bytes would pass
 * CONTROL_SEND_BUFFER_MAX_BYTES is closed instead: the other side isn't reading.
 */
function rawSend(link: Link, message: ControlMessage, onWritten?: () => void): boolean {
  const text = frameFits(message);
  if (text === null) { onWritten?.(); return false; }
  return rawSendText(link, text, onWritten);
}

/** `rawSend` for a frame already serialized (a subscription's event, up to CONTROL_EVENT_FRAME_MAX_BYTES). */
function rawSendText(link: Link, text: string, onWritten?: () => void): boolean {
  let called = false;
  const written = () => { if (!called) { called = true; onWritten?.(); } };
  if (link.closed || link.ws.readyState !== WebSocket.OPEN) { written(); return false; }
  if ((link.ws.bufferedAmount ?? 0) + Buffer.byteLength(text) > CONTROL_SEND_BUFFER_MAX_BYTES) {
    refuseLink(link, CONTROL_CLOSE_BACKLOG, 'backlog', 'the other side is not reading');
    written();
    return false;
  }
  try {
    link.ws.send(text, () => written());
    return true;
  } catch { // telemetry-exempt: a closing socket; its close handler cleans up
    written();
    return false;
  }
}

function closeLink(link: Link, code: number, reason: string, failWith: ControlErrorCode = 'transport_unavailable'): void {
  if (link.closed) return;
  link.closed = true;
  link.bulk.close();
  links.delete(link);
  if (link.announcedReady) {
    link.announcedReady = false;
    devicesChanged();
  }
  if (link.helloTimer) clearTimeout(link.helloTimer);
  if (link.heartbeat) clearInterval(link.heartbeat);
  link.helloTimer = null;
  link.heartbeat = null;
  for (const pending of [...link.pending.values()]) {
    pending.cleanup();
    pending.reject(new ControlRequestError(failWith, !isReadOnlyMethod(pending.method), pending.id));
  }
  link.pending.clear();
  // Requesters stop waiting; their runs go on to settle (or be cut off) on their own clocks.
  for (const reply of link.replying.values()) reply.abort('closed');
  link.replying.clear();
  // A subscription lives only as long as its connection, on both sides.
  stopServing(link);
  for (const [, handlers] of [...link.subscriptions]) notify(() => handlers.onEnd(failWith));
  link.subscriptions.clear();
  try { link.ws.close(code, reason); } catch { /* telemetry-exempt: already closing */ }
  const ws = link.ws;
  const timer = setTimeout(() => { try { ws.terminate(); } catch { /* telemetry-exempt: already gone */ } }, 250);
  timer.unref?.();
}

function refuseLink(link: Link, code: number, reason: string, detail: string): void {
  appLog('core:annex', 'warn', 'Annex control connection closed', {
    meta: { fingerprint: link.fingerprint, direction: link.direction, reason: detail },
  });
  closeLink(link, code, reason, code === CONTROL_CLOSE_REVOKED ? 'authorization_revoked' : 'transport_unavailable');
}

/** The accepting side checks, on every frame, that the other side is still allowed; a removal or new pin ends it at once. */
function inboundStillAllowed(link: Link): boolean {
  if (link.direction !== 'in') return true;
  if (inboundAuthority?.stillAllowed(link.fingerprint, link.pin)) return true;
  refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'no longer allowed');
  return false;
}

function attach(ws: WebSocket, fingerprint: string, pin: string, direction: 'in' | 'out', remoteAddress: string | undefined): Link {
  const link = {
    ws, fingerprint, pin, direction, remoteAddress, features: null, announcedReady: false, requestEpoch: ++nextLinkEpoch, offered: null, closed: false,
    helloTimer: null, heartbeat: null, alive: true, pending: new Map(), replying: new Map(), subscriptions: new Map(), subscription: null,
  } as Link;
  link.bulk = makeBulkLane(link);
  links.add(link);
  link.helloTimer = setTimeout(() => {
    link.helloTimer = null;
    if (!link.features) refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'no_hello', 'no hello');
  }, HELLO_TIMEOUT_MS);
  link.helloTimer.unref?.();
  link.heartbeat = setInterval(() => {
    if (!link.alive) { refuseLink(link, 1001, 'heartbeat', 'no heartbeat'); return; }
    link.alive = false;
    try { ws.ping(); } catch { /* telemetry-exempt: a closing socket */ }
  }, HEARTBEAT_MS);
  link.heartbeat.unref?.();
  ws.on('pong', () => { link.alive = true; });
  ws.on('message', (data: RawData, isBinary: boolean) => onFrame(link, data, isBinary));
  ws.on('close', (code: number) => closeLink(link, 1000, 'closed', code === CONTROL_CLOSE_REVOKED ? 'authorization_revoked' : 'transport_unavailable'));
  ws.on('error', (err) => {
    appLog('core:annex', 'debug', 'Annex control connection error', { meta: { fingerprint, direction, error: err.message } });
  });
  return link;
}

function onFrame(link: Link, data: RawData, isBinary: boolean): void {
  if (link.closed) return;
  link.alive = true;
  if (!inboundStillAllowed(link)) return;
  if (isBinary) {
    if (!link.features?.has('bulk') || rawLength(data) > BULK_CHUNK_BYTES + 40) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'binary frame'); return; }
    link.bulk.binary(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer)); return;
  }
  // The socket takes frames up to the event cap, but only a subscription's `event`, to the side that
  // accepted the connection, may be that large. Everything else keeps CONTROL_FRAME_MAX_BYTES.
  const bytes = rawLength(data);
  if (bytes > CONTROL_FRAME_MAX_BYTES && link.direction === 'out') { refuseLink(link, CONTROL_CLOSE_TOO_LARGE, 'too_large', `${bytes} byte frame`); return; }
  const parsed = parseControlMessage(data.toString());
  if (bytes > CONTROL_FRAME_MAX_BYTES && (!('message' in parsed) || parsed.message.type !== 'event')) {
    refuseLink(link, CONTROL_CLOSE_TOO_LARGE, 'too_large', `${bytes} byte frame`);
    return;
  }
  if ('reason' in parsed) {
    if (parsed.reason === 'version') { refuseLink(link, CONTROL_CLOSE_VERSION, 'version', `version ${parsed.detail}`); return; }
    // A request this side would take, but malformed: answered, not fatal.
    if (parsed.id && link.direction === 'out' && link.features?.has('request')) { rawSend(link, { v: 1, type: 'error', id: parsed.id, code: 'invalid_request' }); return; }
    refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', parsed.detail);
    return;
  }
  const message = parsed.message;
  if (!link.features) { onHello(link, message); return; }
  if (message.type === 'bulk') {
    if (!link.features?.has('bulk')) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'bulk without capability'); return; }
    link.bulk.receive(message); return;
  }
  if (link.direction === 'out') {
    if (message.type === 'request') { void onRequest(link, message); return; }
    if (message.type === 'cancel') { link.bulk.cancel(message.id); link.replying.get(message.id)?.abort('cancelled'); return; }
    if (message.type === 'subscribe') { onSubscribe(link, message.id); return; }
    if (message.type === 'unsubscribe') { if (link.subscription?.id === message.id) stopServing(link); return; }
    if (message.type === 'client') { onClientFrame(link, message); return; }
  } else {
    if (message.type === 'event' || message.type === 'ended' || (message.type === 'error' && link.subscriptions.has(message.id))) {
      onSubscriptionFrame(link, message);
      return;
    }
    if (message.type === 'response' || message.type === 'error') { onAnswer(link, message); return; }
  }
  refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', `unexpected ${message.type}`);
}

/** Close code for a frame larger than its type may be (the WebSocket "message too big"). */
const CONTROL_CLOSE_TOO_LARGE = 1009;

function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data instanceof ArrayBuffer ? data.byteLength : data.length;
}

/** The opener's hello: what it supports. It speaks first. */
function sendOffer(link: Link, features: string[]): void {
  link.offered = new Set(features);
  rawSend(link, { v: CONTROL_PROTOCOL_VERSION, type: 'hello', features });
}

function onHello(link: Link, message: ControlMessage): void {
  if (message.type !== 'hello') { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', `${message.type} before hello`); return; }
  const known = new Set<string>(CONTROL_FEATURES);
  if (link.direction === 'in') {
    // The opener's offer. Answer with what both support; nothing else is ever sent on this connection.
    const agreed = new Set(message.features.filter((f): f is ControlFeature => known.has(f)));
    link.features = agreed;
    rawSend(link, { v: 1, type: 'hello', features: [...agreed] });
  } else {
    // The answer may only narrow the offer.
    if (!link.offered || !message.features.every((f) => link.offered!.has(f) && known.has(f))) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'hello beyond offer'); return; }
    link.features = new Set(message.features as ControlFeature[]);
  }
  if (link.helloTimer) clearTimeout(link.helloTimer);
  link.helloTimer = null;
  appLog('core:annex', 'info', 'Annex control connection ready', {
    meta: { fingerprint: link.fingerprint, direction: link.direction, features: [...link.features] },
  });
  link.onReady?.();
  if (requestReady(link) && !link.announcedReady) {
    link.announcedReady = true;
    devicesChanged();
  }
}

// ---------------------------------------------------------------------------
// Target: running a request
// ---------------------------------------------------------------------------

function sendError(link: Link, id: string, code: ControlErrorCode): void {
  rawSend(link, { v: 1, type: 'error', id, code });
}

function jsonResponse(status: number, body: unknown): ControlResult {
  return { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
}

function toWire(result: ControlResult): ControlHttpResponse {
  return { status: result.status, headers: result.headers, ...encodeControlBody(result.body) };
}

async function onRequest(link: Link, message: Extract<ControlMessage, { type: 'request' }>, fromBulk = false): Promise<void> {
  const { id } = message;
  if (!fromBulk && link.features?.has('bulk') && binaryPath(message.path) && message.body !== undefined) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'binary body outside bulk'); return; }
  if (!link.features?.has('request')) { sendError(link, id, 'not_supported'); return; }
  if (link.replying.has(id)) { sendError(link, id, 'duplicate_id'); return; }
  if (link.replying.size >= MAX_IN_FLIGHT) { sendError(link, id, 'busy'); return; }
  const server = target;
  if (!server) { sendError(link, id, 'unavailable'); return; }

  // As if it had connected directly: the identity and certificate this connection verified, via reverse.
  const auth = server.authorize({ fingerprint: link.fingerprint, pin: link.pin, via: 'reverse' });
  if (isRefusal(auth)) {
    appLog('core:annex', 'warn', 'Refused a reverse request', { meta: { fingerprint: link.fingerprint, error: auth.error, status: auth.status } });
    rawSend(link, { v: 1, type: 'response', id, ...toWire(jsonResponse(auth.status, { error: auth.error, message: auth.message })) });
    return;
  }
  const principal = auth.principal;
  const request: ControlHttpRequest = {
    method: message.method, path: message.path,
    ...(message.headers && { headers: message.headers }), ...(message.body !== undefined && { body: message.body }), ...(message.encoding && { encoding: message.encoding }),
  };
  const reply = new AbortController();
  link.replying.set(id, reply);
  // The slot is held until the answer has been written out, not just queued.
  const release = () => { if (link.replying.get(id) === reply) link.replying.delete(id); };
  const outcome = isReadOnlyMethod(request.method)
    ? await runRead(server, principal, request, link, reply.signal)
    : await runOnce(server, principal, request, id, link, reply.signal);
  // Cancelled, or the connection went: nothing is sent.
  if (link.closed || reply.signal.aborted || outcome === 'cancelled') { release(); return; }
  // Nothing goes to a requester that lost its access while this ran.
  if (!server.stillAuthorized(principal)) {
    release();
    sendError(link, id, 'authorization_revoked');
    refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'revoked while a request ran');
    return;
  }
  if (outcome.kind === 'response' && link.features?.has('bulk') && (binaryPath(request.path) || outcome.response.body.length > BULK_CHUNK_BYTES)) {
    const { status, headers, body } = outcome.response;
    if (link.bulk.send('response', id, { status, headers }, body, release)) return;
    sendError(link, id, 'busy'); release(); return;
  }
  let frame: ControlMessage = outcome.kind === 'response' ? { v: 1, type: 'response', id, ...toWire(outcome.response) }
    : { v: 1, type: 'error', id, code: outcome.kind === 'error' ? outcome.code : 'replay_unavailable' };
  if (frameFits(frame) === null) frame = { v: 1, type: 'error', id, code: 'response_too_large' };
  rawSend(link, frame, release);
}

/** How one run of a handler ended. Only `complete` carries an answer. */
type RunOutcome = { kind: 'complete'; response: ControlResult } | { kind: 'incomplete'; timedOut: boolean } | { kind: 'failed' };

interface Run {
  /** Settles with the handler's response. Its slot frees later, once the route's own work has settled too. */
  done: Promise<RunOutcome>;
  deadline: AbortSignal;
  /** The requester stopped waiting: the handler sees its request close. */
  cancel(): void;
  /** Ends it now: cancelled, and the response cut off. */
  stop(): void;
}

function canStart(principal: AnnexPrincipal): boolean {
  return (activeRuns.get(runKey(principal)) ?? 0) < MAX_IN_FLIGHT;
}

/** Starts the handler for an authorized request, holding one of the requester's slots until it settles. Null when they're all taken. */
function startRun(server: ControlTarget, principal: AnnexPrincipal, request: ControlHttpRequest, link: Link): Run | null {
  const peer = principal.fingerprint;
  const budget = runKey(principal);
  if (!canStart(principal)) return null;
  activeRuns.set(budget, (activeRuns.get(budget) ?? 0) + 1);
  const cancel = new AbortController();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort('timeout'), targetTimeoutMs);
  timer.unref?.();
  const ctx: DispatchContext = { remoteAddress: link.remoteAddress, signal: cancel.signal, deadline: deadline.signal, linkOpen: () => !link.closed && link.ws.readyState === WebSocket.OPEN, responseLimit: link.features?.has('bulk') ? responseBodyLimit(request.path, request.method) : CONTROL_FRAME_MAX_BYTES };
  let dispatched: Promise<DispatchResult>;
  try { dispatched = server.dispatch(principal, request, ctx); } catch (err) { // telemetry-exempt: passed on as a rejection, logged below
    dispatched = Promise.reject(err);
  }
  const done = dispatched
    .then((result): RunOutcome => {
      const { status, headers, body } = result;
      return result.complete ? { kind: 'complete', response: { status, headers, body } } : { kind: 'incomplete', timedOut: deadline.signal.reason === 'timeout' };
    })
    .catch((err): RunOutcome => {
      appLog('core:annex', 'error', 'A reverse request failed', { meta: { fingerprint: peer, method: request.method, error: err instanceof Error ? err.message : String(err) } });
      return { kind: 'failed' };
    })
    .finally(() => clearTimeout(timer));
  // The slot frees only when both the response and the route's own work have settled.
  const settled = dispatched.then((result): Promise<void> | undefined => result.operations, (): undefined => undefined).then((): void => undefined, (): void => undefined);
  void settled.finally(() => {
    const left = (activeRuns.get(budget) ?? 1) - 1;
    if (left > 0) activeRuns.set(budget, left);
    else activeRuns.delete(budget);
  });
  return {
    done, deadline: deadline.signal,
    cancel: () => cancel.abort('cancelled'),
    stop: () => { cancel.abort('cancelled'); deadline.abort('cancelled'); },
  };
}

/** What the requester that ran it gets. A handler that threw answers 500, as an uncaught failure would; one cut off answers `timeout`. */
function answerForRun(outcome: RunOutcome): Stored {
  if (outcome.kind === 'complete') return { kind: 'response', response: outcome.response };
  if (outcome.kind === 'failed') return { kind: 'response', response: jsonResponse(500, { error: 'internal_error' }) };
  return { kind: 'error', code: outcome.timedOut ? 'timeout' : 'cancelled' };
}

/** What a retry gets: only a completed answer is ever replayed. */
function retainedForRun(outcome: RunOutcome): Stored {
  return outcome.kind === 'complete' ? retainedFor(outcome.response) : { kind: 'not_retained' };
}

/** What a retry gets: the original answer within the retention cap, otherwise no replay. */
function retainedFor(response: ControlResult): Stored {
  return response.body.length <= SEEN_RETAIN_MAX_BYTES ? { kind: 'response', response } : { kind: 'not_retained' };
}

function onAbort(signal: AbortSignal, fn: () => void): void {
  if (signal.aborted) fn();
  else signal.addEventListener('abort', fn, { once: true });
}

/** Waits for `work`, until the requester stops waiting (`cancelled`), or until the run's time is up (`timeout`). */
function untilDone(work: Promise<Stored>, reply: AbortSignal, deadline: AbortSignal | null): Promise<Stored | 'cancelled'> {
  return new Promise((resolve) => {
    void work.then(resolve);
    onAbort(reply, () => resolve('cancelled'));
    if (deadline) onAbort(deadline, () => resolve({ kind: 'error', code: 'timeout' }));
  });
}

/** A read has nothing to finish for anyone else: cancelling it ends it. */
function runRead(server: ControlTarget, principal: AnnexPrincipal, request: ControlHttpRequest, link: Link, reply: AbortSignal): Promise<Stored | 'cancelled'> {
  const run = startRun(server, principal, request, link);
  if (!run) return Promise.resolve({ kind: 'error', code: 'busy' });
  onAbort(reply, () => run.stop());
  return untilDone(run.done.then(answerForRun), reply, run.deadline);
}

/**
 * A non-read request runs at most once per id: a retry (on this connection
 * after a lost answer, or on a new one) gets the original outcome, waiting for
 * it if it's still running. If the requester stops waiting the handler still
 * runs to its end (or its deadline), so a retry learns what happened; only a
 * response the handler completed is ever replayed.
 */
function runOnce(server: ControlTarget, principal: AnnexPrincipal, request: ControlHttpRequest, id: string, link: Link, reply: AbortSignal): Promise<Stored | 'cancelled'> {
  const key = SeenCache.key(principal, id);
  const digest = requestDigest(request);
  const known = seen.peek(key, digest);
  if (known.kind === 'conflict') {
    return Promise.resolve({ kind: 'response', response: jsonResponse(409, { error: 'request_conflict', message: 'That request id was already used for a different request.' }) });
  }
  if (known.kind === 'same') return untilDone(known.settled, reply, null);
  // A new one needs a free slot and room to be remembered; running entries are never dropped.
  // Checked and taken in one synchronous step, so two requests can't both take the last slot.
  if (!canStart(principal)) return Promise.resolve({ kind: 'error', code: 'busy' });
  const slot = seen.begin(key, principal.fingerprint, digest);
  if (slot.kind !== 'new') return Promise.resolve({ kind: 'error', code: 'busy' });
  const run = startRun(server, principal, request, link)!;
  onAbort(reply, () => run.cancel());
  void run.done.then((outcome) => slot.finish(retainedForRun(outcome)));
  return untilDone(run.done.then(answerForRun), reply, run.deadline);
}

// ---------------------------------------------------------------------------
// Target: serving a subscription (P4)
// ---------------------------------------------------------------------------

/**
 * Serves the requester this machine's /ws stream: the server registers a
 * virtual /ws client for it, authorized as it would be had it connected
 * directly, and every frame is checked again as it goes.
 */
function onSubscribe(link: Link, id: string): void {
  if (!link.features?.has('subscribe')) { sendError(link, id, 'not_supported'); return; }
  if (link.subscription) { sendError(link, id, 'busy'); return; }
  const server = target;
  if (!server?.subscribe) { sendError(link, id, 'unavailable'); return; }
  // As if it had connected directly: the identity and certificate this connection verified, via reverse.
  const auth = server.authorize({ fingerprint: link.fingerprint, pin: link.pin, via: 'reverse' });
  if (isRefusal(auth)) {
    appLog('core:annex', 'warn', 'Refused a reverse subscription', { meta: { fingerprint: link.fingerprint, error: auth.error, status: auth.status } });
    sendError(link, id, 'authorization_revoked');
    return;
  }
  const principal = auth.principal;
  const served = { id, handle: null, ended: false, principal } as ServedSubscription;
  link.subscription = served;
  const end = (code: ControlEndCode) => {
    if (served.ended) return;
    served.ended = true;
    if (link.subscription === served) link.subscription = null;
    rawSend(link, { v: 1, type: 'ended', id, code });
  };
  const sink: SubscriptionSink = {
    send: (frame) => {
      if (served.ended || link.closed) return false;
      // Every frame is authorized as it goes: nothing reaches a subscriber that has lost its access.
      if (!server.stillAuthorized(principal)) {
        end('authorization_revoked');
        refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'revoked during a subscription');
        return false;
      }
      // The /ws frame goes in as it was serialized: no parse, no second encoding.
      const text = `{"v":1,"type":"event","id":${JSON.stringify(id)},"frame":${frame}}`;
      if (text.length * 3 > CONTROL_EVENT_FRAME_MAX_BYTES && Buffer.byteLength(text) > CONTROL_EVENT_FRAME_MAX_BYTES) {
        end('frame_too_large');
        return false;
      }
      return rawSendText(link, text);
    },
    end,
  };
  served.sink = sink;
  const handle = server.subscribe(principal, sink);
  if (!handle) {
    served.ended = true;
    link.subscription = null;
    sendError(link, id, 'unavailable');
    return;
  }
  served.handle = handle;
  // Over before it was handed back (its first frame was refused): close the server's side now.
  if (served.ended) handle.close();
}

/**
 * A /ws control frame from the subscriber (P5). Only with `ws-control` agreed,
 * only for the connection's live subscription, only the /ws control set, and
 * only while the subscriber is still authorized; then the server's /ws handler
 * runs it for the subscription's virtual client and checks it again.
 */
function onClientFrame(link: Link, message: Extract<ControlMessage, { type: 'client' }>, fromBulk = false): void {
  if (!fromBulk && link.features?.has('bulk') && message.frame.type === 'clipboard:image') { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'clipboard outside bulk'); return; }
  if (!link.features?.has('ws-control')) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'client frame without ws-control'); return; }
  const served = link.subscription;
  // For a subscription that has already ended here: it raced the end, and is dropped.
  if (!served || served.ended || served.id !== message.id || !served.handle) return;
  const server = target;
  if (!server || !server.stillAuthorized(served.principal)) {
    // Tell the subscriber, then end the server's side (its virtual client and every shell it owns):
    // end() lets go of the subscription, so its handle is taken first.
    const handle = served.handle;
    served.sink.end('authorization_revoked');
    handle.close();
    refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'revoked before a client frame');
    return;
  }
  const type = message.frame.type as string;
  if (!(CONTROL_WS_CLIENT_TYPES as readonly string[]).includes(type)) {
    // Answered as /ws answers a refusal, on the subscription: it stays open.
    served.sink.send(JSON.stringify({ type: 'error', payload: { message: 'not_allowed_over_reverse', frameType: type.slice(0, 64) } }));
    return;
  }
  served.handle.receive?.(JSON.stringify(message.frame));
}

/** Stops serving the connection's subscription, if any, without telling the subscriber (it left, or the connection went). */
function stopServing(link: Link): void {
  const served = link.subscription;
  if (!served) return;
  link.subscription = null;
  served.ended = true;
  link.bulk.cancel(served.id);
  served.handle?.close();
}

/** A subscriber's callback must never break the connection. */
function notify(fn: () => void): void {
  try { fn(); } catch (err) { // telemetry-exempt: logged; a subscriber's own failure
    appLog('core:annex', 'error', 'An Annex subscription handler failed', { meta: { error: err instanceof Error ? err.message : String(err) } });
  }
}

/** Requester: a frame for a subscription this machine holds. */
function onSubscriptionFrame(link: Link, message: Extract<ControlMessage, { type: 'event' | 'ended' | 'error' }>): void {
  const handlers = link.subscriptions.get(message.id);
  // For a subscription already closed here: dropped.
  if (!handlers) return;
  if (message.type === 'event') { notify(() => handlers.onFrame(message.frame)); return; }
  link.subscriptions.delete(message.id);
  link.bulk.cancel(message.id);
  notify(() => handlers.onEnd(message.code));
}

/**
 * Subscribes to the /ws stream of the computer `fingerprint`, over the control
 * connection it opened to this machine: a fresh snapshot, then live events, as
 * a /ws socket to it would get them. It authorizes the subscription, and every
 * frame, as if this machine had connected directly. One per connection; after
 * it ends (or the connection goes), subscribe again for a fresh snapshot.
 *
 * Throws a `ControlRequestError` if it can't be sent.
 */
export function subscribe(fingerprint: string, handlers: SubscriptionHandlers): ControlSubscription {
  const id = randomUUID();
  const refuse = (code: ControlErrorCode) => new ControlRequestError(code, false, id);
  const link = linkFor(fingerprint, 'in');
  if (!link || link.ws.readyState !== WebSocket.OPEN || !link.features) throw refuse('transport_unavailable');
  if (!link.features.has('subscribe')) throw refuse('not_supported');
  if (!inboundStillAllowed(link)) throw refuse('authorization_revoked');
  if (link.subscriptions.size > 0) throw refuse('busy');
  link.subscriptions.set(id, handlers);
  if (!rawSend(link, { v: 1, type: 'subscribe', id })) {
    link.subscriptions.delete(id);
    throw refuse('transport_unavailable');
  }
  return {
    id,
    close: () => {
      if (!link.subscriptions.delete(id)) return;
      link.bulk.cancel(id);
      rawSend(link, { v: 1, type: 'unsubscribe', id });
    },
    send: (frame) => {
      if (!link.subscriptions.has(id) || !link.features?.has('ws-control')) return false;
      if (!(CONTROL_WS_CLIENT_TYPES as readonly string[]).includes(frame.type)) return false;
      if (!inboundStillAllowed(link)) return false;
      if (frame.type === 'clipboard:image' && link.features?.has('bulk')) {
        const { base64, ...payload } = frame.payload ?? {};
        if (typeof base64 !== 'string') return false;
        if (base64.length > CLIPBOARD_IMAGE_MAX_BASE64) {
          notify(() => handlers.onFrame({ type: 'error', payload: { message: 'clipboard:image data exceeds 10MB limit' } }));
          return true;
        }
        return link.bulk.send('client', id, { frame: { ...frame, payload } }, Buffer.from(base64));
      }
      return rawSend(link, { v: 1, type: 'client', id, frame: { ...frame } });
    },
  };
}

// ---------------------------------------------------------------------------
// Requester
// ---------------------------------------------------------------------------

function onAnswer(link: Link, message: Extract<ControlMessage, { type: 'response' | 'error' }>): void {
  const pending = link.pending.get(message.id);
  // An answer to a request no longer waited for (cancelled, timed out): dropped.
  if (!pending) return;
  if (message.type === 'response' && message.status >= 200 && message.status < 300 && link.features?.has('bulk') && binaryPath(pending.path)) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'binary answer outside bulk'); return; }
  link.pending.delete(message.id);
  link.bulk.cancel(message.id);
  pending.cleanup();
  if (message.type === 'error') {
    // Only an answer that says it never ran is determinate.
    const neverRan = message.code === 'busy' || message.code === 'duplicate_id' || message.code === 'invalid_request'
      || message.code === 'not_supported' || message.code === 'unavailable' || message.code === 'request_too_large';
    pending.reject(new ControlRequestError(message.code, !neverRan && !isReadOnlyMethod(pending.method), pending.id));
    return;
  }
  if (pending.maxResponseBytes !== undefined && Buffer.byteLength(message.body ?? '', message.encoding ?? 'utf8') > pending.maxResponseBytes) {
    pending.reject(new ControlRequestError('response_too_large', !isReadOnlyMethod(pending.method), pending.id));
    return;
  }
  pending.resolve({ status: message.status, headers: message.headers, body: decodeControlBody(message.body, message.encoding) });
}

function linkFor(fingerprint: string, direction: 'in' | 'out'): Link | undefined {
  let found: Link | undefined;
  for (const link of links) if (link.fingerprint === fingerprint && link.direction === direction && !link.closed) found = link;
  return found;
}

function requestReady(link: Link | undefined): boolean {
  if (!link || link.closed || link.ws.readyState !== WebSocket.OPEN || !link.features?.has('request')) return false;
  if (link.direction === 'in') return !!inboundAuthority?.stillAllowed(link.fingerprint, link.pin);
  return !!target?.authorize({ fingerprint: link.fingerprint, pin: link.pin, via: 'reverse' }).ok;
}

export interface ControlLinkReadiness {
  acceptedHere: boolean;
  openedHere: boolean;
}

/** Desktop observation only: never dials, sends a frame or closes a link. */
export function getLinkReadiness(fingerprint: string): ControlLinkReadiness {
  return {
    acceptedHere: requestReady(linkFor(fingerprint, 'in')),
    openedHere: requestReady(linkFor(fingerprint, 'out')),
  };
}

export function getAcceptedLinkEpoch(fingerprint: string): number {
  const link = linkFor(fingerprint, 'in');
  return link && requestReady(link) ? link.requestEpoch : 0;
}

/** Whether `request()` can reach that computer now: it opened a control connection here that agreed to `feature`. */
export function hasReverseLink(fingerprint: string, feature: ControlFeature = 'request'): boolean {
  const link = linkFor(fingerprint, 'in');
  return !!link?.features?.has(feature) && link.ws.readyState === WebSocket.OPEN;
}

/**
 * Sends a request to the computer `fingerprint` over the control connection it
 * opened to this machine. It authorizes and runs the request as if this machine
 * had connected to it directly.
 *
 * Rejects with a `ControlRequestError`. A non-read request whose answer is lost
 * (connection closed, timeout, cancelled) is `indeterminate`: it may have run.
 * Nothing is retried automatically; retry with the same `requestId` to get the
 * original outcome.
 */
export function request(fingerprint: string, input: ControlRequestInput, options: ControlRequestOptions = {}): Promise<ControlResult> {
  const id = options.requestId ?? randomUUID();
  const fail = (code: ControlErrorCode, indeterminate = false) => Promise.reject(new ControlRequestError(code, indeterminate, id));
  if (options.maxResponseBytes !== undefined && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0)) return fail('invalid_request');
  const link = linkFor(fingerprint, 'in');
  if (!link || link.ws.readyState !== WebSocket.OPEN || !link.features) return fail('transport_unavailable');
  if (!link.features.has('request')) return fail('not_supported');
  if (!inboundStillAllowed(link)) return fail('authorization_revoked');
  if (link.pending.has(id)) return fail('duplicate_id');
  if (link.pending.size >= MAX_PENDING) return fail('busy');
  if (options.signal?.aborted) return fail('cancelled');
  const bytes = input.body === undefined ? undefined : typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : input.body;
  const frame: ControlMessage = {
    v: 1, type: 'request', id, method: input.method, path: input.path,
    ...(input.headers && { headers: input.headers }), ...(bytes && !(link.features?.has('bulk') && (binaryPath(input.path) || bytes.length > BULK_CHUNK_BYTES)) && encodeControlBody(bytes)),
  };
  const readOnly = isReadOnlyMethod(input.method);
  return new Promise<ControlResult>((resolve, reject) => {
    const timer = setTimeout(() => giveUp('timeout'), options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => giveUp('cancelled');
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    function giveUp(code: ControlErrorCode): void {
      if (!link!.pending.delete(id)) return;
      cleanup();
      link!.bulk.cancel(id);
      rawSend(link!, { v: 1, type: 'cancel', id });
      reject(new ControlRequestError(code, !readOnly, id));
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    link.pending.set(id, { id, method: input.method, path: input.path, maxResponseBytes: options.maxResponseBytes, resolve, reject, cleanup, progress: () => timer.refresh?.() });
    if (link.features?.has('bulk') && bytes && (binaryPath(input.path) || bytes.length > BULK_CHUNK_BYTES)) {
      if (bytes.length > CONTROL_FRAME_MAX_BYTES && !/\/attachments$/.test(input.path)) { link.pending.delete(id); cleanup(); reject(new ControlRequestError('request_too_large', false, id)); return; }
      const meta = { method: input.method, path: input.path, ...(input.headers && { headers: input.headers }) };
      if (!link.bulk.send('request', id, meta, bytes)) { link.pending.delete(id); cleanup(); reject(new ControlRequestError('busy', false, id)); }
      return;
    }
    if (frameFits(frame) === null) {
      link.pending.delete(id);
      cleanup();
      reject(new ControlRequestError('request_too_large', false, id));
      return;
    }
    if (!rawSend(link, frame)) {
      link.pending.delete(id);
      cleanup();
      reject(new ControlRequestError('transport_unavailable', false, id));
    }
  });
}

// ---------------------------------------------------------------------------
// Incoming (server: this machine requests)
// ---------------------------------------------------------------------------

function refuseUpgrade(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const json = JSON.stringify(body);
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Service Unavailable'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`);
}

export function isControlUpgrade(pathname: string): boolean {
  return pathname === CONTROL_CHANNEL_PATH;
}

/** Takes an upgrade to `/control` on the main TLS server. Only an active desktop member, pinned, is accepted. */
export function handleControlUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const authority = inboundAuthority;
  if (!authority) { refuseUpgrade(socket, 503, { error: 'unavailable' }); return; }
  const decision = authority.accept(socket);
  if ('error' in decision) {
    appLog('core:annex', 'warn', 'Refused an Annex control connection', { meta: { error: decision.error, remoteAddress: req.socket.remoteAddress } });
    refuseUpgrade(socket, decision.status, { error: decision.error, message: decision.message });
    return;
  }
  wss ??= new WebSocketServer({ noServer: true, maxPayload: CONTROL_EVENT_FRAME_MAX_BYTES });
  wss.handleUpgrade(req, socket, head, (ws) => {
    // One incoming connection per computer: a new one replaces the old (it reconnected, or the old is dead).
    closeFor(decision.fingerprint, 'in');
    attach(ws, decision.fingerprint, decision.pin, 'in', req.socket.remoteAddress);
  });
}

// ---------------------------------------------------------------------------
// Outgoing (client: this machine is the target)
// ---------------------------------------------------------------------------

/**
 * Opens the control connection to `fingerprint` at `host:port`, pinned to its
 * certificate (`pinned`), if this machine is serving and would take reverse
 * requests from that computer. With a connection source, refreshes the
 * independently maintained connection instead of replacing its socket.
 */
export function connectTo(fingerprint: string, host: string, port: number, tlsOptions: tls.ConnectionOptions, pinned: string | undefined): void {
  if (connectionSource) {
    const connection = keptConnections.get(fingerprint);
    if (connection?.blocked === 'stopped') { connection.blocked = undefined; connection.started = false; }
    // A fresh authenticated /ws connection may be a peer that just restarted/upgraded.
    // Ordinary /ws pongs and membership/presence notifications never reset this.
    if (connection && connection.resetFailures > 0) {
      connection.resetFailures = 0;
      connection.attempt = 0;
      if (connection.timer) { clearTimeout(connection.timer); connection.timer = null; }
      if (!connection.socket) connection.started = false;
    }
    refreshConnections();
    return;
  }
  closeFor(fingerprint, 'out');
  openOutgoing(fingerprint, host, port, tlsOptions, pinned);
}

interface OutgoingHooks {
  current(): boolean;
  ready(): void;
  block(reason: 'revoked' | 'pin' | 'unsupported'): void;
  resetBeforeUpgrade(): void;
  closed(code: number): void;
}

function terminalTlsError(err: unknown): boolean {
  return ['cert-mismatch', 'cert-expired', 'cert-not-yet-valid'].includes(classifyConnectionError(err))
    || typeof err === 'object' && err !== null && 'code' in err && err.code === 'ERR_ANNEX_NEEDS_PAIRING';
}

function openOutgoing(fingerprint: string, host: string, port: number, tlsOptions: tls.ConnectionOptions, pinned: string | undefined, hooks?: OutgoingHooks): WebSocket | null {
  // Only to a computer this machine would take reverse requests from, and only while it serves.
  const eligible = (pin: string | undefined) => !!target && !!pin && target.authorize({ fingerprint, pin, via: 'reverse' }).ok;
  if (!host || !port || !eligible(pinned)) return null;
  const authority = net.isIPv6(host) ? `[${host}]` : host;
  const ws = new WebSocket(`wss://${authority}:${port}${CONTROL_CHANNEL_PATH}`, { ...tlsOptions, handshakeTimeout: 10_000, maxPayload: CONTROL_EVENT_FRAME_MAX_BYTES });
  outgoingSockets.set(fingerprint, ws);
  let link: Link | null = null;
  ws.on('upgrade', (res) => {
    const socket = res.socket;
    // The identity and certificate this handshake verified (against the pin) are who later requests come from.
    const shown = socket instanceof tls.TLSSocket ? annexTls.extractPeerFingerprint(socket) : null;
    const pin = socket instanceof tls.TLSSocket ? annexTls.extractPeerCertificateFingerprint(socket) : undefined;
    if (outgoingSockets.get(fingerprint) !== ws || hooks && !hooks.current()) {
      try { ws.terminate(); } catch { /* telemetry-exempt: superseded handshake */ }
      return;
    }
    if (shown !== fingerprint || pin !== pinned || !eligible(pin)) {
      appLog('core:annex', 'warn', 'Closed an Annex control connection to a computer that is not an eligible member', { meta: { fingerprint } });
      hooks?.block(shown !== fingerprint || pin !== pinned ? 'pin' : 'revoked');
      try { ws.terminate(); } catch { /* telemetry-exempt: refused */ }
      return;
    }
    link = attach(ws, fingerprint, pin!, 'out', host);
    link.onReady = () => {
      if (!hooks) return;
      if (!hooks.current()) { closeLink(link!, 1000, 'route_changed'); return; }
      if (!link!.features?.has('request')) { hooks.block('unsupported'); closeLink(link!, 1000, 'not_supported'); return; }
      hooks.ready();
    };
  });
  ws.on('open', () => {
    if (link && !link.closed) sendOffer(link, [...CONTROL_FEATURES]);
  });
  ws.on('unexpected-response', (_req, res) => {
    appLog('core:annex', 'info', 'A paired computer did not open the Annex control connection', { meta: { fingerprint, status: res.statusCode } });
    if (res.statusCode === 401 || res.statusCode === 403) hooks?.block('revoked');
    else if (res.statusCode === 404 || res.statusCode === 405 || res.statusCode === 426) hooks?.block('unsupported');
    res.resume();
    try { ws.terminate(); } catch { /* telemetry-exempt: refused upgrade */ }
  });
  ws.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (terminalTlsError(err)) hooks?.block('pin');
    if (!link && code === 'ECONNRESET') hooks?.resetBeforeUpgrade();
    if (link) return;
    appLog('core:annex', 'info', 'Annex control connection not opened', { meta: { fingerprint, error: err.message } });
  });
  ws.on('close', (code) => {
    if (outgoingSockets.get(fingerprint) === ws) outgoingSockets.delete(fingerprint);
    hooks?.closed(code);
  });
  return ws;
}

/** The client supplies only locally known routes; the server's authorizer remains authoritative. */
export function setConnectionSource(source: ControlConnectionSource | null): void {
  closeAll('out');
  connectionSource = source;
  refreshConnections();
}

function allowedRoutes(plan: ControlConnectionPlan): AnnexRoute[] {
  return plan.routes.filter((route) => routeAllowed(route, plan.fingerprint, plan.localFingerprint));
}

function routesKey(plan: ControlConnectionPlan): string {
  return JSON.stringify(allowedRoutes(plan).map(({ host, port, privateTo }) => [host, port, privateTo]));
}

function cancelKept(connection: KeptConnection, revoked = false): void {
  if (connection.timer) clearTimeout(connection.timer);
  connection.timer = null;
  const ws = connection.socket;
  connection.socket = null;
  connection.route = null;
  connection.readyAt = null;
  let attached = false;
  for (const link of [...links]) {
    if (link.direction === 'out' && link.fingerprint === connection.plan.fingerprint) {
      attached = true;
      closeLink(link, revoked ? CONTROL_CLOSE_REVOKED : 1000, revoked ? 'authorization_revoked' : 'closed',
        revoked ? 'authorization_revoked' : 'transport_unavailable');
    }
  }
  if (ws) {
    if (outgoingSockets.get(connection.plan.fingerprint) === ws) outgoingSockets.delete(connection.plan.fingerprint);
    if (!attached) { try { ws.terminate(); } catch { /* telemetry-exempt: already closed */ } }
  }
}

/** Reconcile membership/routes, preserving a live socket only while its endpoint remains allowed. */
export function refreshConnections(): void {
  const plans = target && connectionSource ? connectionSource.plans() : [];
  const wanted = new Map(plans.filter((plan) => target?.authorize({ fingerprint: plan.fingerprint, pin: plan.pin, via: 'reverse' }).ok)
    .map((plan) => [plan.fingerprint, plan]));
  for (const [fingerprint, connection] of keptConnections) {
    const plan = wanted.get(fingerprint);
    if (!plan || plan.trust !== connection.plan.trust || plan.pin !== connection.plan.pin) {
      keptConnections.delete(fingerprint);
      cancelKept(connection, true);
    }
  }
  for (const plan of wanted.values()) {
    let connection = keptConnections.get(plan.fingerprint);
    if (!connection) {
      connection = {
        plan, routeKey: routesKey(plan), attempt: 0, nextRoute: 0, started: false,
        timer: null, socket: null, route: null, readyAt: null, resetFailures: 0, everReady: false,
      };
      keptConnections.set(plan.fingerprint, connection);
    } else {
      const key = routesKey(plan);
      if (key !== connection.routeKey) {
        connection.resetFailures = 0;
        connection.everReady = false;
        connection.attempt = 0;
        connection.nextRoute = 0;
        if (connection.timer) { clearTimeout(connection.timer); connection.timer = null; }
        if (connection.blocked === 'unsupported') connection.blocked = undefined;
        if (!connection.socket) connection.started = false;
      }
      connection.routeKey = key;
      connection.plan = plan;
      if (connection.socket && !allowedRoutes(plan).some((route) =>
        route.host === connection.route?.host && route.port === connection.route?.port)) {
        cancelKept(connection);
        connection.started = false;
      }
    }
    if (!connectionSource?.autoReconnect() && connection.timer) {
      clearTimeout(connection.timer);
      connection.timer = null;
    }
    if (!connection.started && !connection.blocked && allowedRoutes(plan).length) dialKept(connection);
    else if (!connection.socket && !connection.timer) scheduleKept(connection);
  }
}

function currentPlan(connection: KeptConnection): ControlConnectionPlan | undefined {
  if (keptConnections.get(connection.plan.fingerprint) !== connection || connection.blocked || !target) return undefined;
  const plan = connectionSource?.plans().find((candidate) => candidate.fingerprint === connection.plan.fingerprint
    && candidate.trust === connection.plan.trust && candidate.pin === connection.plan.pin);
  return plan && target.authorize({ fingerprint: plan.fingerprint, pin: plan.pin, via: 'reverse' }).ok ? plan : undefined;
}

function dialKept(connection: KeptConnection): void {
  const plan = currentPlan(connection);
  if (!plan || connection.socket || connection.timer) return;
  const routes = allowedRoutes(plan);
  if (!routes.length) return;
  const route = routes[connection.nextRoute % routes.length];
  connection.started = true;
  connection.route = route;
  connection.readyAt = null;
  let resetBeforeUpgrade = false;
  const current = () => {
    if (connection.socket !== ws) return false;
    const fresh = currentPlan(connection);
    return !!fresh && allowedRoutes(fresh).some((candidate) => candidate.host === route.host && candidate.port === route.port);
  };
  const closed = (code: number) => {
    if (keptConnections.get(plan.fingerprint) !== connection || connection.socket !== ws) return;
    connection.socket = null;
    connection.route = null;
    connection.resetFailures = resetBeforeUpgrade && !connection.everReady
      ? Math.min(connection.resetFailures + 1, UNKNOWN_PEER_RESET_LIMIT) : 0;
    if (code === CONTROL_CLOSE_REVOKED) connection.blocked = 'revoked';
    else if (code === CONTROL_CLOSE_VERSION || code === CONTROL_CLOSE_PROTOCOL) connection.blocked = 'unsupported';
    if (connection.readyAt !== null && Date.now() - connection.readyAt >= HEARTBEAT_MS) {
      connection.attempt = 0;
    } else {
      connection.nextRoute++;
    }
    scheduleKept(connection);
  };
  let ws: WebSocket | null = null;
  try {
    ws = openOutgoing(plan.fingerprint, route.host, route.port, plan.tlsOptions(), plan.pin, {
      current, closed,
      ready: () => {
        if (current()) { connection.readyAt = Date.now(); connection.everReady = true; connection.resetFailures = 0; }
      },
      resetBeforeUpgrade: () => { resetBeforeUpgrade = true; },
      block: (reason) => {
        if (keptConnections.get(plan.fingerprint) === connection && connection.socket === ws) connection.blocked = reason;
      },
    });
    connection.socket = ws;
    if (!ws) connection.route = null;
  } catch (err) { // telemetry-exempt: setup failure is logged below and enters bounded backoff
    appLog('core:annex', 'warn', 'Could not open an Annex control route', {
      meta: { fingerprint: plan.fingerprint, error: err instanceof Error ? err.message : String(err) },
    });
    if (terminalTlsError(err)) connection.blocked = 'pin';
    connection.route = null;
    scheduleKept(connection);
  }
}

function scheduleKept(connection: KeptConnection): void {
  const plan = currentPlan(connection);
  if (!plan || !allowedRoutes(plan).length || connection.timer || connection.socket || !connectionSource?.autoReconnect()) return;
  const base = Math.min(1_000 * 2 ** connection.attempt, RECONNECT_MAX_MS);
  const delay = connection.resetFailures >= UNKNOWN_PEER_RESET_LIMIT && !connection.everReady
    ? Math.round(UNKNOWN_PEER_PROBE_MS * (0.5 + Math.random()))
    : Math.min(RECONNECT_MAX_MS, Math.round(base * (0.5 + Math.random())));
  connection.attempt = Math.min(connection.attempt + 1, 5);
  connection.timer = setTimeout(() => {
    connection.timer = null;
    if (!connectionSource?.autoReconnect()) return;
    dialKept(connection);
  }, delay);
  connection.timer.unref?.();
}

/** An existing explicit Retry action may re-probe, never a background membership/presence burst. */
export function retryConnection(fingerprint: string): void {
  const connection = keptConnections.get(fingerprint);
  if (connection && !connection.socket) {
    connection.blocked = undefined;
    connection.started = false;
    connection.attempt = 0;
    connection.resetFailures = 0;
    connection.nextRoute = 0;
    if (connection.timer) { clearTimeout(connection.timer); connection.timer = null; }
  }
  refreshConnections();
}

/**
 * Closes control connections with a computer: `out` ones this machine opened,
 * `in` ones it accepted, or both. Waiting requests fail; with `revoked`, as
 * `authorization_revoked`, and what the target remembered for it is forgotten.
 */
export function closeFor(fingerprint: string, direction: 'in' | 'out' | 'both' = 'both', revoked = false): void {
  if (direction !== 'in') {
    const connection = keptConnections.get(fingerprint);
    if (connection) {
      connection.blocked = revoked ? 'revoked' : 'stopped';
      cancelKept(connection, revoked);
    }
    const ws = outgoingSockets.get(fingerprint);
    outgoingSockets.delete(fingerprint);
    if (ws && ![...links].some((link) => link.ws === ws)) {
      try { ws.terminate(); } catch { /* telemetry-exempt: already closed */ }
    }
  }
  for (const link of [...links]) {
    if (link.fingerprint !== fingerprint || (direction !== 'both' && link.direction !== direction)) continue;
    closeLink(link, revoked ? CONTROL_CLOSE_REVOKED : 1000, revoked ? 'authorization_revoked' : 'closed', revoked ? 'authorization_revoked' : 'transport_unavailable');
  }
  if (revoked) seen.forgetPeer(fingerprint);
}

/** Closes every control connection in one direction. */
export function closeAll(direction: 'in' | 'out' | 'both' = 'both'): void {
  if (direction !== 'in') {
    const outgoing = [...keptConnections.values()];
    keptConnections.clear();
    for (const connection of outgoing) cancelKept(connection);
    for (const ws of outgoingSockets.values()) {
      if (![...links].some((link) => link.ws === ws)) {
        try { ws.terminate(); } catch { /* telemetry-exempt: already closed */ }
      }
    }
    outgoingSockets.clear();
  }
  for (const link of [...links]) if (direction === 'both' || link.direction === direction) closeLink(link, 1001, 'stopping');
  if (direction !== 'out') {
    wss?.close();
    wss = null;
  }
}

/** Test helper. */
export function resetControlForTests(): void {
  connectionSource = null;
  closeAll();
  seen.clear();
  activeRuns.clear();
  targetTimeoutMs = TARGET_TIMEOUT_MS;
  bulkTokenLimitForTests = undefined;
  inboundAuthority = null;
  target = null;
  nextLinkEpoch = 0;
}

/** Test helper: wraps an already-open socket as a control connection, as an accepted upgrade (`in`) or an opened one (`out`) would. */
export function _attachForTesting(ws: WebSocket, fingerprint: string, pin: string, direction: 'in' | 'out', remoteAddress = '127.0.0.1'): void {
  attach(ws, fingerprint, pin, direction, remoteAddress);
}

/** Test helper: sends the opener's hello on a test connection. */
export function _sendHelloForTesting(fingerprint: string, features: string[] = [...CONTROL_FEATURES]): void {
  const link = linkFor(fingerprint, 'out');
  if (link) sendOffer(link, features);
}

/** Test helper: what the target remembers. */
export function _seenSizeForTesting(): number {
  return seen.size;
}

/** Test helper: the socket of the connection `fingerprint` opened to this machine, if any. */
export function _inboundSocketForTesting(fingerprint: string): WebSocket | undefined {
  return linkFor(fingerprint, 'in')?.ws;
}

/** Test helper: how long a target lets one request run (null restores the default). */
export function _setTargetTimeoutForTesting(ms: number | null): void {
  targetTimeoutMs = ms ?? TARGET_TIMEOUT_MS;
}

/** Test helper: runs not yet settled for a requester. */
export function _activeRunsForTesting(fingerprint: string, pin: string): number {
  return activeRuns.get(runKey({ fingerprint, pin })) ?? 0;
}

/** Test helper: exercise lifetime exhaustion without allocating the production history budget. */
export function _setBulkTokenLimitForTesting(limit: number): void { bulkTokenLimitForTests = limit; }
