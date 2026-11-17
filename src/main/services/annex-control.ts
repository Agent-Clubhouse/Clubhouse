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
 * Later slices add features to the hello (subscriptions, terminals, bulk
 * transfers) and their own lanes; P2's route abstraction calls `request()` for
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
  CONTROL_CLOSE_PROTOCOL,
  CONTROL_CLOSE_REVOKED,
  CONTROL_CLOSE_VERSION,
  CONTROL_FEATURES,
  CONTROL_FRAME_MAX_BYTES,
  CONTROL_PROTOCOL_VERSION,
  decodeControlBody,
  encodeControlBody,
  isReadOnlyMethod,
  parseControlMessage,
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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** How long a connection may stay silent before its hello, before it's closed. */
export const HELLO_TIMEOUT_MS = 10_000;
/** A ping this often; no pong by the next one and the connection is dead. */
export const HEARTBEAT_MS = 30_000;
/** How long a requester waits for an answer by default (the same as a direct REST call). */
export const REQUEST_TIMEOUT_MS = 30_000;
/** Longest a target lets one request run (the same bound as a direct request on the main port). */
export const TARGET_TIMEOUT_MS = 60_000;
/** Requests a target runs at once for one connection; more are answered `busy`. */
export const MAX_IN_FLIGHT = 16;
/** Requests a requester has waiting on one connection. */
export const MAX_PENDING = 64;
/** How long a target remembers a finished non-read request, so a retry with its id gets the same answer. */
export const SEEN_TTL_MS = 10 * 60_000;
/** Remembered requests per requester. The oldest finished one goes first. */
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
  signal: AbortSignal;
  /** The connection the request came over is still open. */
  linkOpen: () => boolean;
}

/** What the target side needs from the server: the authorizer and the route table. */
export interface ControlTarget {
  /** The P1 authorizer, for a caller that is always `via: 'reverse'`. */
  authorize(caller: AnnexCaller): AnnexAuthResult;
  /** Whether that principal is still authorized now. */
  stillAuthorized(principal: AnnexPrincipal): boolean;
  /** Runs a request already authorized as `principal` through the route table. */
  dispatch(principal: AnnexPrincipal, request: ControlHttpRequest, ctx: DispatchContext): Promise<ControlResult>;
}

interface Pending {
  id: string;
  method: ControlMethod;
  resolve: (result: ControlResult) => void;
  reject: (err: ControlRequestError) => void;
  cleanup: () => void;
}

interface Running {
  abort: AbortController;
}

interface Link {
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
  /** What the opener offered in its hello (`out` only). */
  offered: Set<string> | null;
  closed: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
  heartbeat: ReturnType<typeof setInterval> | null;
  alive: boolean;
  pending: Map<string, Pending>;
  running: Map<string, Running>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const links = new Set<Link>();
let inboundAuthority: InboundAuthority | null = null;
let target: ControlTarget | null = null;
let wss: WebSocketServer | null = null;

/** The server sets this while it runs; without it nothing is accepted. */
export function setInboundAuthority(authority: InboundAuthority | null): void {
  inboundAuthority = authority;
  if (!authority) closeAll('in');
}

/** The server sets this while it runs; without it this machine opens no control connection and runs no request. */
export function setControlTarget(next: ControlTarget | null): void {
  target = next;
  if (!next) closeAll('out');
}

/** Whether this machine can be a target now (its server is running). */
export function canServe(): boolean {
  return target !== null;
}

// ---------------------------------------------------------------------------
// Seen-cache (target)
// ---------------------------------------------------------------------------

/** A finished request as the target remembers it. `not_retained`: it finished, but its answer was too large to keep. */
type Stored = { kind: 'response'; response: ControlHttpResponse } | { kind: 'not_retained' } | { kind: 'error'; code: ControlErrorCode };

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

  /** `new`: run it and call `finish`. `same`: wait for (or replay) the original. `conflict`: a different request under that id. */
  begin(key: string, peer: string, digest: string): { kind: 'new'; finish: (stored: Stored) => void } | { kind: 'same'; settled: Promise<Stored> } | { kind: 'conflict' } {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) return existing.digest === digest ? { kind: 'same', settled: existing.settled } : { kind: 'conflict' };
    let finish!: (stored: Stored) => void;
    const settled = new Promise<Stored>((resolve) => { finish = resolve; });
    const entry: SeenEntry = { peer, digest, at: this.now(), done: null, settled };
    this.entries.set(key, entry);
    this.evict(peer);
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

  private evict(peer: string): void {
    const mine = [...this.entries].filter(([, e]) => e.peer === peer);
    let over = mine.length - SEEN_MAX_PER_PEER;
    for (const [key, entry] of mine) {
      if (over <= 0) break;
      if (!entry.done) continue;
      this.entries.delete(key);
      over--;
    }
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

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

function frameFits(message: ControlMessage): string | null {
  const text = JSON.stringify(message);
  return Buffer.byteLength(text) <= CONTROL_FRAME_MAX_BYTES ? text : null;
}

function rawSend(link: Link, message: ControlMessage): boolean {
  if (link.closed || link.ws.readyState !== WebSocket.OPEN) return false;
  const text = frameFits(message);
  if (text === null) return false;
  try { link.ws.send(text); return true; } catch { return false; /* telemetry-exempt: a closing socket; its close handler cleans up */ }
}

function closeLink(link: Link, code: number, reason: string, failWith: ControlErrorCode = 'transport_unavailable'): void {
  if (link.closed) return;
  link.closed = true;
  links.delete(link);
  if (link.helloTimer) clearTimeout(link.helloTimer);
  if (link.heartbeat) clearInterval(link.heartbeat);
  link.helloTimer = null;
  link.heartbeat = null;
  for (const pending of [...link.pending.values()]) {
    pending.cleanup();
    pending.reject(new ControlRequestError(failWith, !isReadOnlyMethod(pending.method), pending.id));
  }
  link.pending.clear();
  for (const running of link.running.values()) running.abort.abort();
  link.running.clear();
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
  const link: Link = {
    ws, fingerprint, pin, direction, remoteAddress, features: null, offered: null, closed: false,
    helloTimer: null, heartbeat: null, alive: true, pending: new Map(), running: new Map(),
  };
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
  ws.on('close', () => closeLink(link, 1000, 'closed'));
  ws.on('error', (err) => {
    appLog('core:annex', 'debug', 'Annex control connection error', { meta: { fingerprint, direction, error: err.message } });
  });
  return link;
}

function onFrame(link: Link, data: RawData, isBinary: boolean): void {
  if (link.closed) return;
  link.alive = true;
  if (!inboundStillAllowed(link)) return;
  if (isBinary) { refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', 'binary frame'); return; }
  const parsed = parseControlMessage(data.toString());
  if ('reason' in parsed) {
    if (parsed.reason === 'version') { refuseLink(link, CONTROL_CLOSE_VERSION, 'version', `version ${parsed.detail}`); return; }
    // A request this side would take, but malformed: answered, not fatal.
    if (parsed.id && link.direction === 'out' && link.features?.has('request')) { rawSend(link, { v: 1, type: 'error', id: parsed.id, code: 'invalid_request' }); return; }
    refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', parsed.detail);
    return;
  }
  const message = parsed.message;
  if (!link.features) { onHello(link, message); return; }
  if (link.direction === 'out') {
    if (message.type === 'request') { void onRequest(link, message); return; }
    if (message.type === 'cancel') { link.running.get(message.id)?.abort.abort('cancelled'); return; }
  } else if (message.type === 'response' || message.type === 'error') {
    onAnswer(link, message);
    return;
  }
  refuseLink(link, CONTROL_CLOSE_PROTOCOL, 'protocol', `unexpected ${message.type}`);
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
}

// ---------------------------------------------------------------------------
// Target: running a request
// ---------------------------------------------------------------------------

function sendError(link: Link, id: string, code: ControlErrorCode): void {
  rawSend(link, { v: 1, type: 'error', id, code });
}

function jsonResponse(status: number, body: unknown): ControlHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, ...encodeControlBody(Buffer.from(JSON.stringify(body))) };
}

function toWire(result: ControlResult): ControlHttpResponse {
  return { status: result.status, headers: result.headers, ...encodeControlBody(result.body) };
}

async function onRequest(link: Link, message: Extract<ControlMessage, { type: 'request' }>): Promise<void> {
  const { id } = message;
  if (!link.features?.has('request')) { sendError(link, id, 'not_supported'); return; }
  if (link.running.has(id)) { sendError(link, id, 'duplicate_id'); return; }
  if (link.running.size >= MAX_IN_FLIGHT) { sendError(link, id, 'busy'); return; }
  const server = target;
  if (!server) { sendError(link, id, 'unavailable'); return; }

  // As if it had connected directly: the identity and certificate this connection verified, via reverse.
  const auth = server.authorize({ fingerprint: link.fingerprint, pin: link.pin, via: 'reverse' });
  if (isRefusal(auth)) {
    appLog('core:annex', 'warn', 'Refused a reverse request', { meta: { fingerprint: link.fingerprint, error: auth.error, status: auth.status } });
    rawSend(link, { v: 1, type: 'response', id, ...jsonResponse(auth.status, { error: auth.error, message: auth.message }) });
    return;
  }
  const principal = auth.principal;
  const request: ControlHttpRequest = {
    method: message.method, path: message.path,
    ...(message.headers && { headers: message.headers }), ...(message.body !== undefined && { body: message.body }), ...(message.encoding && { encoding: message.encoding }),
  };
  const abort = new AbortController();
  link.running.set(id, { abort });
  const timer = setTimeout(() => abort.abort('timeout'), TARGET_TIMEOUT_MS);
  timer.unref?.();
  const ctx: DispatchContext = { remoteAddress: link.remoteAddress, signal: abort.signal, linkOpen: () => !link.closed };
  let outcome: Stored | 'aborted';
  try {
    outcome = isReadOnlyMethod(request.method)
      ? await untilAborted(runHandler(server, principal, request, ctx, link).then(answerFor), abort.signal)
      : await runOnce(server, principal, request, id, ctx, link);
  } finally {
    clearTimeout(timer);
    link.running.delete(id);
  }
  // The connection went: nothing is sent.
  if (link.closed) return;
  // Cancelled: the requester stopped waiting. Timed out here: it's told.
  if (outcome === 'aborted') {
    if (abort.signal.reason === 'timeout') sendError(link, id, 'timeout');
    return;
  }
  // Nothing goes to a requester that lost its access while this ran.
  if (!server.stillAuthorized(principal)) {
    sendError(link, id, 'authorization_revoked');
    refuseLink(link, CONTROL_CLOSE_REVOKED, 'authorization_revoked', 'revoked while a request ran');
    return;
  }
  if (outcome.kind === 'error') { sendError(link, id, outcome.code); return; }
  if (outcome.kind === 'not_retained') { sendError(link, id, 'replay_unavailable'); return; }
  if (!rawSend(link, { v: 1, type: 'response', id, ...outcome.response })) sendError(link, id, 'response_too_large');
}

/** The route handler's answer. A handler that throws answers 500, as an uncaught failure would. */
function runHandler(server: ControlTarget, principal: AnnexPrincipal, request: ControlHttpRequest, ctx: DispatchContext, link: Link): Promise<ControlHttpResponse> {
  return server.dispatch(principal, request, ctx)
    .then(toWire)
    .catch((err) => {
      appLog('core:annex', 'error', 'A reverse request failed', { meta: { fingerprint: link.fingerprint, method: request.method, error: err instanceof Error ? err.message : String(err) } });
      return jsonResponse(500, { error: 'internal_error' });
    });
}

/** What the requester that ran it gets: the answer, unless it can't fit in a frame. */
function answerFor(response: ControlHttpResponse): Stored {
  return Buffer.byteLength(response.body) + 1024 <= CONTROL_FRAME_MAX_BYTES ? { kind: 'response', response } : { kind: 'error', code: 'response_too_large' };
}

/** What a retry gets: the same answer, or, for one too large to keep, `replay_unavailable`. Never a second run. */
function retainedFor(response: ControlHttpResponse): Stored {
  const answer = answerFor(response);
  if (answer.kind !== 'response') return answer;
  return Buffer.byteLength(response.body) <= SEEN_RETAIN_MAX_BYTES ? answer : { kind: 'not_retained' };
}

/** Waits for `work`, or until the request is cancelled or times out here. */
function untilAborted(work: Promise<Stored>, signal: AbortSignal): Promise<Stored | 'aborted'> {
  if (signal.aborted) return Promise.resolve('aborted');
  return Promise.race([work, new Promise<'aborted'>((resolve) => signal.addEventListener('abort', () => resolve('aborted'), { once: true }))]);
}

/**
 * A non-read request runs at most once per id: a retry (on this connection
 * after a lost answer, or on a new one) gets the original outcome, waiting for
 * it if it's still running. It runs to its end even if this requester stops
 * waiting, so a retry learns what happened.
 */
async function runOnce(server: ControlTarget, principal: AnnexPrincipal, request: ControlHttpRequest, id: string, ctx: DispatchContext, link: Link): Promise<Stored | 'aborted'> {
  const slot = seen.begin(SeenCache.key(principal, id), principal.fingerprint, requestDigest(request));
  if (slot.kind === 'conflict') {
    return { kind: 'response', response: jsonResponse(409, { error: 'request_conflict', message: 'That request id was already used for a different request.' }) };
  }
  if (slot.kind === 'same') return untilAborted(slot.settled, ctx.signal);
  const ran = runHandler(server, principal, request, ctx, link);
  void ran.then((response) => slot.finish(retainedFor(response)));
  return untilAborted(ran.then(answerFor), ctx.signal);
}

// ---------------------------------------------------------------------------
// Requester
// ---------------------------------------------------------------------------

function onAnswer(link: Link, message: Extract<ControlMessage, { type: 'response' | 'error' }>): void {
  const pending = link.pending.get(message.id);
  // An answer to a request no longer waited for (cancelled, timed out): dropped.
  if (!pending) return;
  link.pending.delete(message.id);
  pending.cleanup();
  if (message.type === 'error') {
    // Only an answer that says it never ran is determinate.
    const neverRan = message.code === 'busy' || message.code === 'duplicate_id' || message.code === 'invalid_request'
      || message.code === 'not_supported' || message.code === 'unavailable' || message.code === 'request_too_large';
    pending.reject(new ControlRequestError(message.code, !neverRan && !isReadOnlyMethod(pending.method), pending.id));
    return;
  }
  pending.resolve({ status: message.status, headers: message.headers, body: decodeControlBody(message.body, message.encoding) });
}

function linkFor(fingerprint: string, direction: 'in' | 'out'): Link | undefined {
  let found: Link | undefined;
  for (const link of links) if (link.fingerprint === fingerprint && link.direction === direction && !link.closed) found = link;
  return found;
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
    ...(input.headers && { headers: input.headers }), ...(bytes && encodeControlBody(bytes)),
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
      rawSend(link!, { v: 1, type: 'cancel', id });
      reject(new ControlRequestError(code, !readOnly, id));
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    link.pending.set(id, { id, method: input.method, resolve, reject, cleanup });
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
  wss ??= new WebSocketServer({ noServer: true, maxPayload: CONTROL_FRAME_MAX_BYTES });
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
 * requests from that computer. A refused or unknown path (an older
 * Clubhouse) just leaves it closed until the next main connection.
 */
export function connectTo(fingerprint: string, host: string, port: number, tlsOptions: tls.ConnectionOptions, pinned: string | undefined): void {
  closeFor(fingerprint, 'out');
  // Only to a computer this machine would take reverse requests from, and only while it serves.
  const eligible = (pin: string | undefined) => !!target && !!pin && target.authorize({ fingerprint, pin, via: 'reverse' }).ok;
  if (!host || !port || !eligible(pinned)) return;
  const authority = net.isIPv6(host) ? `[${host}]` : host;
  const ws = new WebSocket(`wss://${authority}:${port}${CONTROL_CHANNEL_PATH}`, { ...tlsOptions, handshakeTimeout: 10_000, maxPayload: CONTROL_FRAME_MAX_BYTES });
  let link: Link | null = null;
  ws.on('upgrade', (res) => {
    const socket = res.socket;
    // The identity and certificate this handshake verified (against the pin) are who later requests come from.
    const shown = socket instanceof tls.TLSSocket ? annexTls.extractPeerFingerprint(socket) : null;
    const pin = socket instanceof tls.TLSSocket ? annexTls.extractPeerCertificateFingerprint(socket) : undefined;
    if (shown !== fingerprint || !eligible(pin)) {
      appLog('core:annex', 'warn', 'Closed an Annex control connection to a computer that is not an eligible member', { meta: { fingerprint } });
      try { ws.terminate(); } catch { /* telemetry-exempt: refused */ }
      return;
    }
    link = attach(ws, fingerprint, pin!, 'out', host);
  });
  ws.on('open', () => {
    if (link && !link.closed) sendOffer(link, [...CONTROL_FEATURES]);
  });
  ws.on('unexpected-response', (_req, res) => {
    appLog('core:annex', 'info', 'A paired computer did not open the Annex control connection', { meta: { fingerprint, status: res.statusCode } });
    try { ws.terminate(); } catch { /* telemetry-exempt: refused upgrade */ }
  });
  ws.on('error', (err) => {
    if (link) return;
    appLog('core:annex', 'info', 'Annex control connection not opened', { meta: { fingerprint, error: err.message } });
  });
}

/**
 * Closes control connections with a computer: `out` ones this machine opened,
 * `in` ones it accepted, or both. Waiting requests fail; with `revoked`, as
 * `authorization_revoked`, and what the target remembered for it is forgotten.
 */
export function closeFor(fingerprint: string, direction: 'in' | 'out' | 'both' = 'both', revoked = false): void {
  for (const link of [...links]) {
    if (link.fingerprint !== fingerprint || (direction !== 'both' && link.direction !== direction)) continue;
    closeLink(link, revoked ? CONTROL_CLOSE_REVOKED : 1000, revoked ? 'authorization_revoked' : 'closed', revoked ? 'authorization_revoked' : 'transport_unavailable');
  }
  if (revoked) seen.forgetPeer(fingerprint);
}

/** Closes every control connection in one direction. */
export function closeAll(direction: 'in' | 'out' | 'both' = 'both'): void {
  for (const link of [...links]) if (direction === 'both' || link.direction === direction) closeLink(link, 1001, 'stopping');
  if (direction !== 'out') {
    wss?.close();
    wss = null;
  }
}

/** Test helper. */
export function resetControlForTests(): void {
  closeAll();
  seen.clear();
  inboundAuthority = null;
  target = null;
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
