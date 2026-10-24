/**
 * Annex satellite and controller telemetry (spec §4.12, §7, Phase 6).
 *
 * Rules from §7: each install exports only its own telemetry; trace context
 * crosses Annex only as a `traceparent` (random ids and a sampled flag); the
 * event stream is counted, never spanned; and peer identity is never an
 * attribute. Fingerprints are used here only as local Map keys and are
 * never exported.
 *
 * No OpenTelemetry imports: part of the main bundle.
 */
import { isIP } from 'net';
import { ATTR, type TelAttr } from '../../shared/telemetry/attributes';
import { isTelemetryActive, replaySpan, tel, withRemoteParent } from './facade';
import type { ErrorType } from './types';
import { rememberAnnexIncidentTrace } from './feedback-incident';

type PairResult = Parameters<typeof ATTR.annexPairResult>[0];
type DisconnectReason = Parameters<typeof ATTR.annexDisconnectReason>[0];
type EventType = Parameters<typeof ATTR.annexEventType>[0];
type AuthMode = Parameters<typeof ATTR.annexAuthMode>[0];

const satellite = ATTR.annexRole('satellite');
const controller = ATTR.annexRole('controller');

/** Address family of a host, never the host itself. */
export function addrFamily(host: string | undefined): Parameters<typeof ATTR.addrFamily>[0] {
  const bare = host?.replace(/^\[|\]$/g, '') ?? '';
  const v = isIP(bare);
  return v === 4 ? 'ipv4' : v === 6 ? 'ipv6' : 'hostname';
}

export function attemptBucket(attempt: number): Parameters<typeof ATTR.attemptBucket>[0] {
  if (attempt <= 1) return '1';
  if (attempt === 2) return '2';
  if (attempt <= 5) return '3-5';
  if (attempt <= 10) return '6-10';
  return '>10';
}

// --- Satellite ------------------------------------------------------------------

/**
 * Route template from an ANNEX_HTTP_ROUTE_TABLE entry: path parameters become
 * `:id` (the git operation group `:op`) and query suffixes are dropped, so
 * `GET /api/v1/agents/abc/buffer` is `GET /api/v1/agents/:id/buffer`.
 */
export function routeTemplate(method: string, pattern: RegExp): Parameters<typeof ATTR.annexRoute>[0] {
  const path = pattern.source
    .replace(/^\^|\$$/g, '')
    .replace(/\(\\\?\.\*\)\?/g, '')
    .replace(/\(\[\^\/\]\+\?\)|\(\[\^\/\]\+\)|\(\[\^\/\?\]\+\)/g, ':id')
    .replace(/\(stage\|[^)]*\)/g, ':op')
    .replace(/\\\//g, '/');
  return `${method} ${path}` as Parameters<typeof ATTR.annexRoute>[0];
}

function httpClass(status: number): Parameters<typeof ATTR.httpClass>[0] {
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  if (status >= 300) return '3xx';
  return '2xx';
}

/**
 * Standard level: one `clubhouse.annex.rest` span per request, named by route
 * template. `statusOf` reads the response status after the handler ran.
 */
export function annexRestFlow<T>(method: string, pattern: RegExp, statusOf: () => number, fn: () => Promise<T>): Promise<T> {
  return tel.flow('clubhouse.annex.rest', { attrs: [ATTR.annexRoute(routeTemplate(method, pattern))] }, async (span) => {
    rememberAnnexIncidentTrace();
    const result = await fn();
    span.set(ATTR.httpClass(httpClass(statusOf())));
    return result;
  }, { classify: () => (statusOf() >= 500 ? { error: 'unknown' } : 'ok') });
}

/**
 * The trace context a satellite may continue from a WS message: only the
 * remote spawn/wake messages carry one (they are mTLS-gated before this runs).
 */
export function annexCommandFlow<T>(tc: string | undefined, fn: () => Promise<T>): Promise<T> {
  return withRemoteParent(tc, () => tel.flow('clubhouse.annex.command', {}, () => {
    rememberAnnexIncidentTrace();
    return fn();
  }), true);
}

export function wsTraceparent(type: string | undefined, tc: unknown): string | undefined {
  if (type !== 'agent:spawn' && type !== 'agent:wake' && type !== 'agent:kill') return undefined;
  return typeof tc === 'string' ? tc : undefined;
}

/**
 * The trace context a satellite may continue from a REST request: only from
 * an mTLS-authenticated controller (desktop or pinned mobile), never a bearer client.
 */
export function restTraceparent(header: string | string[] | undefined, mtls: boolean): string | undefined {
  return mtls && typeof header === 'string' ? header : undefined;
}

export function recordServerStarted(startMs: number, tls: boolean, atMs = Date.now()): void {
  replaySpan({
    name: 'clubhouse.annex.server.start',
    startMs,
    endMs: Math.max(atMs, startMs),
    attrs: [satellite, ATTR.annexTls(tls)],
    outcome: 'ok',
  });
}

export function recordTlsFallback(): void {
  tel.event('clubhouse.annex.tls_fallback', [satellite]);
}

/** The satellite answered a POST /pair. */
export function recordPairServed(startMs: number, result: PairResult, atMs = Date.now()): void {
  replaySpan({
    name: 'clubhouse.annex.pair',
    startMs,
    endMs: Math.max(atMs, startMs),
    attrs: [satellite, ATTR.annexPairResult(result)],
    outcome: result === 'ok' ? 'ok' : 'error',
    errorType: result === 'ok' ? undefined : 'pair_rejected',
  });
}

export function recordSnapshotBuild(startMs: number, atMs = Date.now()): void {
  tel.count('clubhouse.annex.snapshot.build.duration', (atMs - startMs) / 1000);
}

const EVENT_TYPES = new Set<string>([
  'pty:data', 'pty:exit', 'hook:event', 'chat:event', 'permission:request', 'permission:response',
  'agent:spawned', 'agent:woken', 'agent:status', 'agent:completed', 'snapshot', 'canvas:state', 'theme:changed',
  'group-project:list', 'group-project:changed', 'bulletin:message',
]);

function eventType(type: string): EventType {
  return (EVENT_TYPES.has(type) ? type : 'other') as EventType;
}

/** One broadcast: counted once (not per client), with its serialized UTF-8 size in bytes. */
export function recordBroadcast(type: string, bytes: number, sendFailures: number): void {
  if (!isTelemetryActive()) return;
  const attrs = [ATTR.annexEventType(eventType(type))];
  tel.count('clubhouse.annex.events', 1, attrs);
  tel.count('clubhouse.annex.events.bytes', bytes, attrs);
  if (sendFailures > 0) tel.count('clubhouse.annex.send_failures', sendFailures, attrs);
}

/** Connected WS clients after a connect or close. mTLS ≈ desktop, bearer ≈ mobile. */
export function recordClients(desktop: number, mobile: number): void {
  tel.count('clubhouse.annex.clients', desktop, [ATTR.annexClientKind('desktop')]);
  tel.count('clubhouse.annex.clients', mobile, [ATTR.annexClientKind('mobile')]);
}

export function recordControlDenied(channel: 'ws' | 'rest'): void {
  tel.count('clubhouse.annex.control.denied', 1, [ATTR.annexControlChannel(channel)]);
}

export function recordReplay(result: 'ok' | 'gap' | 'send_failed'): void {
  tel.count('clubhouse.annex.replays', 1, [ATTR.annexReplayResult(result)]);
}

export function recordIdentityRegenerated(reason: 'corrupt' | 'reset'): void {
  tel.event('clubhouse.annex.identity.regenerated', [ATTR.identityRegenReason(reason)]);
}

// --- Controller -----------------------------------------------------------------

/** GET /identity for a discovered service; `errorType` unset on success. */
export function recordDiscover(startMs: number, host: string | undefined, errorType?: ErrorType, atMs = Date.now()): void {
  replaySpan({
    name: 'clubhouse.annex.discover',
    startMs,
    endMs: Math.max(atMs, startMs),
    attrs: [controller, ATTR.addrFamily(addrFamily(host))],
    outcome: errorType ? 'error' : 'ok',
    errorType,
  });
}

const PAIR_ERRORS: Record<string, PairResult> = {
  invalid_pin: 'invalid_pin',
  rate_limited: 'rate_limited',
  pairing_locked: 'locked',
  invalid_public_key: 'invalid_key',
  invalid_json: 'invalid_request',
  identity_not_ready: 'identity_not_ready',
};

/** Map a satellite's pairing error code to the registry result. */
export function pairResultFor(code: string | undefined): PairResult {
  return (code && PAIR_ERRORS[code]) || 'other';
}

/** Controller pairing, as a flow. `resultOf` maps pairWithService's own result. */
export function pairFlow<T>(fn: () => Promise<T>, resultOf: (r: T) => PairResult): Promise<T> {
  return tel.flow('clubhouse.annex.pair', { attrs: [controller] }, async (span) => {
    const r = await fn();
    span.set(ATTR.annexPairResult(resultOf(r)));
    return r;
  }, { classify: (r) => (resultOf(r) === 'ok' ? 'ok' : { error: 'pair_rejected' }) });
}

interface PendingConnect {
  startMs: number;
  family: Parameters<typeof ATTR.addrFamily>[0];
  authMode?: AuthMode;
}

/** Keyed by satellite fingerprint, locally only; the key is never exported. */
const connects = new Map<string, PendingConnect>();

export function connectStarted(key: string, host: string | undefined, atMs = Date.now()): void {
  if (!isTelemetryActive() || connects.has(key)) return;
  connects.set(key, { startMs: atMs, family: addrFamily(host) });
}

function endConnect(key: string, attrs: TelAttr[], errorType: ErrorType | undefined, atMs: number): void {
  const pending = connects.get(key);
  if (!pending) return;
  connects.delete(key);
  replaySpan({
    name: 'clubhouse.annex.connect',
    startMs: pending.startMs,
    endMs: Math.max(atMs, pending.startMs),
    attrs: [controller, ATTR.addrFamily(pending.family), ...attrs],
    outcome: errorType ? 'error' : 'ok',
    errorType,
  });
}

/** The WS opened and the peer certificate checked out, with this auth mode. */
export function connectAuthMode(key: string, authMode: AuthMode): void {
  const pending = connects.get(key);
  if (pending) pending.authMode = authMode;
}

/** A snapshot arrived: the connect succeeded. A no-op when no connect is pending. */
export function connectSucceeded(key: string, atMs = Date.now()): void {
  const mode = connects.get(key)?.authMode;
  endConnect(key, mode ? [ATTR.annexAuthMode(mode)] : [], undefined, atMs);
}

/**
 * A pending connect ended without a snapshot. `undefined` (the user
 * disconnected while connecting) drops it without a span.
 */
export function connectFailed(key: string, errorType: ErrorType | undefined, atMs = Date.now()): void {
  if (!errorType) {
    connects.delete(key);
    return;
  }
  endConnect(key, [], errorType, atMs);
}

/** Map the client's local disconnect text to a connect error type (the text is never sent). */
export function connectErrorFor(text: string | undefined): ErrorType | undefined {
  if (text === undefined) return undefined;
  if (text === 'Peer certificate unavailable') return 'cert_missing';
  if (text === 'Peer certificate mismatch') return 'cert_mismatch';
  if (text === 'Incompatible Annex version') return 'protocol_incompatible';
  if (/timed? ?out/i.test(text)) return 'handshake_timeout';
  if (/401|403|unauthorized|forbidden|authentication/i.test(text)) return 'auth_rejected';
  return 'ws_error';
}

/** Map the client's local disconnect text to a disconnect reason. */
export function disconnectReasonFor(text: string | undefined): DisconnectReason {
  if (text === undefined) return 'user';
  if (text === 'Heartbeat timeout') return 'heartbeat_timeout';
  if (text === 'Heartbeat ping failed') return 'heartbeat_failed';
  if (text === 'Connection closed') return 'connection_closed';
  if (text === 'Incompatible Annex version' || text.startsWith('Peer certificate')) return 'other';
  return 'ws_error';
}

export function recordReconnectScheduled(attempt: number, delayMs: number): void {
  const attrs = [ATTR.attemptBucket(attemptBucket(attempt))];
  tel.count('clubhouse.annex.reconnects', 1, attrs);
  tel.count('clubhouse.annex.reconnect.delay', delayMs / 1000, attrs);
}

export function recordDisconnect(reason: DisconnectReason): void {
  tel.count('clubhouse.annex.disconnects', 1, [ATTR.annexDisconnectReason(reason)]);
}

export function recordHeartbeatRtt(ms: number): void {
  tel.count('clubhouse.annex.heartbeat.rtt', ms / 1000);
}

/** Test-only reset. */
export function _resetAnnexTelemetryForTests(): void {
  connects.clear();
}
