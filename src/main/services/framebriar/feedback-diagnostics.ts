/**
 * Recent diagnostics for a feedback report (#2658), the only way diag lines leave the
 * computer. Memory only: a tap on diag (telemetry/diag.ts) keeps a small ring, so this
 * works with telemetry export and local logging off and never reads the log folder.
 *
 * An allowlist, not a scrubber. `msg` and `meta` can hold anything (chat text, paths,
 * project names, a token in an error), so nothing is copied from a line unless the catalog
 * below names it: a known namespace and message becomes a fixed event name, and only that
 * message's fields come along, each reduced to a kind. Ids become a keyed hash for this run
 * and error text becomes one failure word. A warning or error with no catalog entry keeps
 * only its namespace, level, time and failure word. Everything else is dropped when the tap
 * sees it, before it is stored.
 */
import { createHmac, randomBytes } from 'crypto';
import { FEEDBACK_DIAGNOSTICS, type FeedbackDiagnosticLine, type FeedbackDiagnostics } from '../../../shared/feedback-types';
import { KNOWN_LOG_NAMESPACES } from '../../../shared/log-namespaces';
import type { DiagLevel } from '../../../shared/telemetry/diag';
import { addDiagTap } from '../../telemetry/diag';
import type { DiagRecord } from '../../telemetry/diag-sink';

/** Kept in memory, more than a report takes so one noisy stretch doesn't empty the window. */
const MAX_KEPT_LINES = 400;
/** Withheld lines have their own budget: a burst of unknown warnings can't push out connection events. */
const MAX_KEPT_WITHHELD = 100;
export const WITHHELD_EVENT = 'log.withheld';

type FieldKind = 'ref' | 'count' | 'statusCode' | 'closeCode' | 'exitCode' | 'link' | 'state' | 'reason' | 'cli' | 'failure';
/** A meta key's kind and the attr it becomes. Names avoid `auth`, `token` and the like: the SDK drops those keys. */
type FieldSpec = readonly [FieldKind, string];
type Fields = Readonly<Record<string, FieldSpec>>;

const PEER: Fields = { fingerprint: ['ref', 'peerRef'] };
const AGENT: Fields = { agentId: ['ref', 'agentRef'] };
const FAILURE: Fields = { error: ['failure', 'failure'] };
const DRIVER: Fields = { ...AGENT, driver: ['cli', 'driver'] };

interface CatalogEntry {
  /** The stable name sent for this line. The message itself is never sent. */
  event: string;
  msg: string | RegExp;
  fields?: Fields;
  /** Attrs from a RegExp's named groups, each a number or state word the pattern pins down. */
  groups?: Fields;
}

/**
 * What may be sent, per namespace. `feedback-diagnostics.test.ts` fails when a literal here
 * is no longer logged. The shape follows Framebriar's report diagnostics v1, which Clubhouse
 * adopts once that SDK ships, so keep `event` and attrs within its token rules.
 */
export const DIAGNOSTICS_CATALOG: Readonly<Record<string, readonly CatalogEntry[]>> = {
  'core:annex': [
    { event: 'annex.server.starting', msg: 'Annex server starting...' },
    { event: 'annex.server.stopped', msg: 'Annex server stopped' },
    { event: 'annex.server.enabled', msg: 'Annex server started via settings' },
    { event: 'annex.server.disabled', msg: 'Annex server stopped via settings' },
    { event: 'annex.server.start_failed', msg: 'Failed to start Annex server', fields: FAILURE },
    { event: 'annex.server.listen_failed', msg: 'Annex main server failed to listen', fields: FAILURE },
    { event: 'annex.pairing.listen_failed', msg: 'Annex pairing server failed to listen', fields: FAILURE },
    { event: 'annex.server.tls_fallback', msg: 'TLS server creation failed, falling back to plain HTTP', fields: FAILURE },
    { event: 'annex.ws.rejected_origin', msg: 'WebSocket upgrade rejected — invalid origin' },
    { event: 'annex.ws.rejected_unauthorized', msg: 'WebSocket upgrade rejected — unauthorized' },
    { event: 'annex.ws.accepted', msg: 'WebSocket upgrade accepted', fields: { authType: ['link', 'link'] } },
    // Only the close code: the close reason is text the client chose.
    { event: 'annex.ws.disconnected', msg: 'WebSocket client disconnected', fields: { authType: ['link', 'link'], code: ['closeCode', 'closeCode'] } },
    { event: 'annex.ws.heartbeat_terminated', msg: 'Heartbeat: terminating unresponsive WebSocket client' },
    { event: 'annex.ws.snapshot_failed', msg: 'Failed to send snapshot on connect', fields: FAILURE },
    { event: 'annex.ws.broadcast_failed', msg: 'broadcastWs: failed to send to client', fields: FAILURE },
  ],
  'core:annex-client': [
    { event: 'annex.client.connecting', msg: 'Connecting to satellite', fields: { ...PEER, authMode: ['link', 'link'] } },
    { event: 'annex.client.connected', msg: 'Connected to satellite', fields: PEER },
    {
      event: 'annex.client.state',
      msg: /^Satellite state: (?<from>[a-z_-]{1,24}) → (?<to>[a-z_-]{1,24})$/,
      fields: { ...PEER, ...FAILURE },
      groups: { from: ['state', 'fromState'], to: ['state', 'toState'] },
    },
    {
      event: 'annex.client.reconnect_scheduled',
      msg: /^Scheduling reconnect in (?<delay>\d{1,9})ms \(attempt (?<attempt>\d{1,6})\)$/,
      fields: PEER,
      groups: { delay: ['count', 'backoffMs'], attempt: ['count', 'attempt'] },
    },
    { event: 'annex.client.reconnect_disabled', msg: 'Auto-reconnect disabled, not scheduling', fields: PEER },
    { event: 'annex.client.retry_bearer', msg: 'Retrying connection with bearer token after TLS verification', fields: PEER },
    { event: 'annex.client.peer_cert_missing', msg: 'Peer certificate is unavailable on the TLS socket; rejecting connection', fields: PEER },
    { event: 'annex.client.ws_error', msg: 'WebSocket error', fields: { ...PEER, ...FAILURE, attempt: ['count', 'attempt'] } },
    { event: 'annex.client.heartbeat_timeout', msg: 'Heartbeat pong timeout — closing connection', fields: PEER },
    { event: 'annex.client.disconnecting', msg: 'Disconnecting satellite', fields: { ...PEER, previousState: ['state', 'fromState'] } },
    { event: 'annex.client.unknown_peer', msg: 'Cannot connect — unknown peer', fields: PEER },
    { event: 'annex.client.already_connecting', msg: 'Satellite already connecting/connected', fields: PEER },
    { event: 'annex.client.identity_failed', msg: 'Identity request failed', fields: { status: ['statusCode', 'statusCode'] } },
    { event: 'annex.client.identity_error', msg: 'Identity request error', fields: FAILURE },
    { event: 'annex.client.discovery_failed', msg: 'Failed to start Bonjour discovery', fields: FAILURE },
  ],
  'core:chat': [
    { event: 'chat.starting', msg: 'Starting chat agent', fields: { ...DRIVER, provider: ['cli', 'provider'] } },
    { event: 'chat.open', msg: 'Chat session open', fields: DRIVER },
    { event: 'chat.ended', msg: 'Chat session ended', fields: { ...AGENT, reason: ['reason', 'reason'], exitCode: ['exitCode', 'exitCode'] } },
    { event: 'chat.stopping', msg: 'Stopping chat session', fields: DRIVER },
    { event: 'chat.start_failed', msg: 'Chat start failed', fields: { ...DRIVER, ...FAILURE } },
    { event: 'chat.start_abandoned', msg: 'Abandoning chat start', fields: DRIVER },
    { event: 'chat.start_cancelling', msg: 'Cancelling chat start', fields: { ...AGENT, reason: ['reason', 'reason'] } },
    { event: 'chat.start_cancelled', msg: 'Chat start cancelled; not opening the terminal', fields: AGENT },
    { event: 'chat.no_driver', msg: 'No chat driver registered for provider; using the terminal', fields: { ...AGENT, provider: ['cli', 'provider'] } },
    { event: 'chat.cli_missing', msg: 'CLI binary not found for chat; using the terminal', fields: AGENT },
    { event: 'chat.probe_failed', msg: 'Chat handshake probe failed', fields: { driver: ['cli', 'driver'], ...FAILURE } },
    { event: 'chat.driver_close_failed', msg: 'Driver close failed', fields: { ...AGENT, ...FAILURE } },
  ],
  'core:agent': [
    { event: 'agent.sleep', msg: 'Agent went to sleep', fields: AGENT },
    { event: 'agent.resume_exited', msg: 'Resume failed: the CLI exited right away', fields: AGENT },
    { event: 'agent.resume_no_session', msg: 'Resume failed: the CLI has no such session', fields: AGENT },
    { event: 'agent.session_gone', msg: 'Saved session is gone from the CLI store; starting fresh', fields: AGENT },
    { event: 'agent.kill_failed', msg: 'killAgent failed (process may already be dead)', fields: { ...AGENT, ...FAILURE } },
  ],
  'core:feedback': [
    { event: 'feedback.access', msg: /^Feedback access: (?<to>[a-z-]{1,32})$/, fields: { from: ['state', 'fromState'], notice: ['reason', 'reason'] }, groups: { to: ['state', 'toState'] } },
    { event: 'feedback.outbox', msg: /^Feedback outbox: (?<to>[a-z-]{1,32})$/, fields: { from: ['state', 'fromState'], pending: ['count', 'count'] }, groups: { to: ['state', 'toState'] } },
    { event: 'feedback.delivered', msg: 'Feedback delivered' },
    { event: 'feedback.start_failed', msg: 'Feedback start failed', fields: FAILURE },
    { event: 'feedback.send_failed', msg: 'Feedback send failed', fields: FAILURE },
  ],
  'core:startup': [{ event: 'app.starting', msg: /^Clubhouse v[A-Za-z0-9.+-]{1,40} starting$/ }],
  'core:shutdown': [{ event: 'app.os_session_end', msg: 'OS asked to end the session (shutdown, restart or logoff)' }],
};

const KNOWN_NAMESPACES = new Set(KNOWN_LOG_NAMESPACES);
const SERIOUS = new Set<DiagLevel>(['warn', 'error', 'fatal']);
/** Error text is never sent: a system error code in it picks one of these, and anything else is `unknown`. */
const FAILURE_BY_CODE: Readonly<Record<string, string>> = {
  ETIMEDOUT: 'timeout', ENOTFOUND: 'dns', EAI_AGAIN: 'dns', ECONNREFUSED: 'refused', ECONNRESET: 'closed', ECONNABORTED: 'closed',
  EPIPE: 'closed', EHOSTUNREACH: 'offline', ENETUNREACH: 'offline', EPROTO: 'tls', EACCES: 'auth', EPERM: 'auth', EBUSY: 'busy', ENOSPC: 'storage',
};
const SYSTEM_ERROR = new RegExp(`\\b(${Object.keys(FAILURE_BY_CODE).join('|')})\\b`);
/**
 * The only words a line can carry, closed per kind: a project or agent name in one of these
 * fields looks just like a state, so a pattern can't tell them apart. An unknown word is
 * dropped, so a new state goes missing from reports until it is added here.
 */
const WORDS: Readonly<Record<'link' | 'state' | 'reason' | 'cli', ReadonlySet<string>>> = {
  link: new Set(['mtls', 'bearer', 'mtls-first']),
  state: new Set([
    'disconnected', 'discovering', 'connecting', 'connected',
    'checking', 'offline', 'stopped', 'disconnecting', 'expired', 'access-required', 'connection-uncertain', 'storage-unavailable', 'migration-required',
    'available',
  ]),
  reason: new Set(['stopped', 'idle_timeout', 'process_exit', 'fallback', 'error', 'killed', 'superseded', 'expired', 'access-required', 'connection-uncertain', 'migration-required']),
  cli: new Set(['claude-code', 'copilot-cli', 'codex-cli', 'claude_agent_sdk', 'claude_stream_json', 'codex_app_server', 'copilot_acp', 'copilot_sdk', 'acp']),
};

function failure(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const text = typeof value === 'string' ? value : (value as { message?: unknown }).message;
  const code = typeof text === 'string' ? SYSTEM_ERROR.exec(text)?.[1] : undefined;
  return code ? FAILURE_BY_CODE[code] : 'unknown';
}

function integer(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'string' && /^\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

export interface DiagnosticsRing {
  /** The diag tap: reduces one line to what the catalog allows, or drops it. */
  note(record: Readonly<DiagRecord>): void;
  /** The newest lines within the time, line and byte bounds, oldest first. */
  collect(): FeedbackDiagnostics;
}

export function createDiagnosticsRing(opts: { now?: () => number; salt?: Buffer; maxBytes?: number } = {}): DiagnosticsRing {
  const now = opts.now ?? Date.now;
  const salt = opts.salt ?? randomBytes(32);
  let kept: FeedbackDiagnosticLine[] = [];
  let withheld: FeedbackDiagnosticLine[] = [];

  /** Tells lines about the same peer or agent apart within this run, and can't be reversed without the salt. */
  const ref = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? createHmac('sha256', salt).update(value).digest('hex').slice(0, 16) : undefined;

  function reduce(kind: FieldKind, value: unknown): string | number | undefined {
    switch (kind) {
      case 'ref': return ref(value);
      case 'count': return integer(value, 0, 1e12);
      case 'statusCode': return integer(value, 100, 599);
      case 'closeCode': return integer(value, 1000, 4999);
      case 'exitCode': return integer(value, -1024, 1024);
      case 'link':
      case 'state':
      case 'reason':
      case 'cli': return typeof value === 'string' && WORDS[kind].has(value) ? value : undefined;
      case 'failure': return failure(value);
    }
  }

  function attrsOf(spec: Fields | undefined, source: Record<string, unknown> | undefined, out: Record<string, string | number>): void {
    if (!spec || !source) return;
    for (const [key, [kind, name]] of Object.entries(spec)) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = reduce(kind, source[key]);
      if (value !== undefined) out[name] = value;
    }
  }

  const levelOf = (level: DiagLevel): FeedbackDiagnosticLine['level'] => (level === 'fatal' ? 'error' : level);

  return {
    note(record) {
      if (record.level === 'debug' || !KNOWN_NAMESPACES.has(record.ns)) return;
      const base = { at: new Date(now()).toISOString(), level: levelOf(record.level), ns: record.ns };
      for (const entry of DIAGNOSTICS_CATALOG[record.ns] ?? []) {
        const match = typeof entry.msg === 'string' ? entry.msg === record.msg : entry.msg.exec(record.msg);
        if (!match) continue;
        const attrs: Record<string, string | number> = {};
        attrsOf(entry.fields, record.meta, attrs);
        if (match !== true) attrsOf(entry.groups, match.groups, attrs);
        kept.push({ ...base, event: entry.event, ...(Object.keys(attrs).length > 0 && { attrs }) });
        if (kept.length > MAX_KEPT_LINES) kept = kept.slice(-MAX_KEPT_LINES);
        return;
      }
      if (!SERIOUS.has(record.level)) return;
      const reason = failure(record.meta?.error);
      withheld.push({ ...base, event: WITHHELD_EVENT, ...(reason && { attrs: { failure: reason } }) });
      if (withheld.length > MAX_KEPT_WITHHELD) withheld = withheld.slice(-MAX_KEPT_WITHHELD);
    },
    collect() {
      const end = now();
      const windowStart = new Date(end - FEEDBACK_DIAGNOSTICS.windowMinutes * 60_000).toISOString();
      const window = { windowStart, windowEnd: new Date(end).toISOString() };
      // ISO times in one format sort and compare as text.
      const recent = [...kept, ...withheld].filter((l) => l.at >= windowStart).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      const lines: FeedbackDiagnosticLine[] = [];
      let bytes = 0;
      // Newest first, so the moments before the report are what survive the bounds.
      for (let i = recent.length - 1; i >= 0 && lines.length < FEEDBACK_DIAGNOSTICS.maxLines; i--) {
        const size = Buffer.byteLength(JSON.stringify(recent[i]), 'utf-8');
        if (bytes + size > (opts.maxBytes ?? FEEDBACK_DIAGNOSTICS.maxBytes)) break;
        bytes += size;
        lines.unshift(recent[i]);
      }
      return lines.length > 0
        ? { status: 'available', ...window, lines, bytes, dropped: recent.length - lines.length }
        : { status: 'none', reason: 'no_lines', ...window, lines: [], bytes: 0, dropped: 0 };
    },
  };
}

let ring: DiagnosticsRing | null = null;

/** Start keeping lines for reports (idempotent). Redaction runs only for namespaces that can be kept. */
export function startFeedbackDiagnostics(): void {
  if (ring) return;
  const started = createDiagnosticsRing();
  ring = started;
  addDiagTap((record) => started.note(record), (ns, level) => level !== 'debug' && KNOWN_NAMESPACES.has(ns));
}

/** What a report opened now could attach. */
export function collectFeedbackDiagnostics(): FeedbackDiagnostics {
  return (ring ?? createDiagnosticsRing()).collect();
}
