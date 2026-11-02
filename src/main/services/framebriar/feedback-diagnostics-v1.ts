/**
 * Framebriar's report field, diagnostics v1, as Clubhouse would fill it (#2658). Not sent yet:
 * FeedbackServiceDeps.reportDiagnosticsField is off until an approved first live report has
 * verified storage and readback. Reports use the excerpt path until then. Pure.
 *
 * The SDK's normalizeDiagnostics is the contract, and the service runs it again. The contract's
 * attrs are closed, and its words come from closed client sets. A line's value that doesn't fit
 * is dropped and counted, as the service would count it, rather than sent as something it isn't.
 */
import { DIAGNOSTICS_CONTRACT, DIAGNOSTICS_LIMITS, type FramebriarDiagnosticsEntry, type FramebriarReportDiagnostics } from '../../vendor/framebriar/adapters/node/index.mjs';
import type { FeedbackDiagnostics, FeedbackDiagnosticsNoneReason, FeedbackDiagnosticsOutcome } from '../../../shared/feedback-types';
import { DIAGNOSTICS_WORDS } from './feedback-diagnostics';

const TOKEN = new RegExp(DIAGNOSTICS_CONTRACT.tokenPattern);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURES = new Set(DIAGNOSTICS_CONTRACT.attrs.enums.failure);
const COUNTS = new Set(DIAGNOSTICS_CONTRACT.attrs.numbers);
const DELIVERY_RESULTS = new Set(DIAGNOSTICS_CONTRACT.deliveryResults);

const REF = /^[0-9a-f]{16}$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
/** `mtls-first` is only what the client tries first: it doesn't show mTLS was used. */
const LINKS: ReadonlyMap<string, string> = new Map([['mtls', 'mtls'], ['bearer', 'bearer'], ['unknown', 'unknown'], ['mtls-first', 'unknown']]);
/** Sent when a line's exit code doesn't fit 0-255 (a signal, null or Windows status) and nothing else says how it ended. */
const EXIT_CODE_UNAVAILABLE = 'exit_code_unavailable';
/** Sent for a provider or driver outside the closed set, so its name stays here. */
const CUSTOM_CLI = 'custom';
/**
 * The contract's words for why there are no entries. `not_connected` and `no_review` have none,
 * so the SDK reads them as `empty`: an open question on #2658, since lines do exist for the first.
 */
const NONE_REASONS: Partial<Record<FeedbackDiagnosticsNoneReason, string>> = { no_lines: 'empty', collection_failed: 'provider-failed' };
/** The chat runtime logs a literal 0 on every session end, never a code it saw, so it can't be sent as one. */
const UNOBSERVED_EXIT_CODE_EVENTS: ReadonlySet<string> = new Set(['chat.ended']);
/** What each event was trying to do. An event that only reports a reached state has none. */
export const OPERATION_BY_EVENT: ReadonlyMap<string, string> = new Map([
  ['annex.server.starting', 'server.start'],
  ['annex.server.start_failed', 'server.start'],
  ['annex.server.listen_failed', 'server.listen'],
  ['annex.pairing.listen_failed', 'pairing.listen'],
  ['annex.ws.snapshot_failed', 'snapshot.send'],
  ['annex.ws.broadcast_failed', 'broadcast.send'],
  ['annex.client.connecting', 'connect'],
  ['annex.client.retry_bearer', 'connect'],
  ['annex.client.identity_failed', 'identity.fetch'],
  ['annex.client.identity_error', 'identity.fetch'],
  ['annex.client.discovery_failed', 'discovery.start'],
  ['chat.starting', 'chat.start'],
  ['chat.start_failed', 'chat.start'],
  ['chat.stopping', 'chat.stop'],
  ['chat.probe_failed', 'chat.probe'],
  ['agent.kill_failed', 'agent.kill'],
  ['feedback.start_failed', 'feedback.start'],
  ['feedback.send_failed', 'feedback.send'],
]);
const OPERATIONS = new Set(OPERATION_BY_EVENT.values());

const inRange = (value: unknown, min: number, max: number): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

function validAttr(key: string, value: unknown): boolean {
  if (COUNTS.has(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const text = typeof value === 'string' ? value : '';
  switch (key) {
    case 'statusCode': return inRange(value, 100, 599);
    case 'closeCode': return inRange(value, 1000, 4999);
    case 'failure': return FAILURES.has(text);
    case 'operation': return OPERATIONS.has(text);
    case 'exitCode': return inRange(value, 0, 255);
    case 'peerRef':
    case 'agentRef': return REF.test(text);
    case 'fromState':
    case 'toState': return DIAGNOSTICS_WORDS.state.has(text);
    case 'reason': return DIAGNOSTICS_WORDS.reason.has(text);
    case 'connectionId':
    case 'attemptId': return UUID.test(text);
    case 'traceId': return /^[0-9a-f]{32}$/.test(text) || UUID.test(text);
    case 'spanId': return /^[0-9a-f]{16}$/.test(text);
    default: return false;
  }
}

function mapAttr(key: string, value: unknown): string | number | undefined {
  if (key === 'link') return typeof value === 'string' ? LINKS.get(value) : undefined;
  if (key === 'provider' || key === 'driver') {
    if (typeof value !== 'string' || value === '') return undefined;
    return DIAGNOSTICS_WORDS.cli.has(value) ? value : CUSTOM_CLI;
  }
  if (!validAttr(key, value)) return undefined;
  // The service wants ids in lower case.
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : (value as string | number);
}

const validAt = (at: string): boolean => AT.test(at) && !Number.isNaN(Date.parse(at));

/** The contract drops a delivery with no valid count, and stores a missing lastResult as `unknown`. */
function mapDelivery({ queued, lastResult }: DiagnosticsV1Delivery): FramebriarReportDiagnostics['delivery'] {
  if (queued === undefined || !inRange(queued, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  return { queued, lastResult: lastResult !== undefined && DELIVERY_RESULTS.has(lastResult) ? lastResult : 'unknown' };
}

export type DiagnosticsV1 = FramebriarReportDiagnostics;

export interface DiagnosticsV1Delivery {
  /** How many reports were waiting in the outbox when the report was captured. */
  queued?: number;
  /** `ok`, `none` (no attempt this process) or a failure word. */
  lastResult?: string;
}

export function toDiagnosticsV1(diagnostics: FeedbackDiagnostics, outcome: FeedbackDiagnosticsOutcome, delivery: DiagnosticsV1Delivery = {}): DiagnosticsV1 {
  const base = { v: 1 as const, windowStart: diagnostics.windowStart, windowEnd: diagnostics.windowEnd };
  const empty = { ...base, lines: 0, bytes: 0, dropped: 0, droppedAttrs: 0, entries: [] as FramebriarDiagnosticsEntry[] };
  if (outcome.status === 'left_out') return { state: 'left_out', ...empty };
  if (outcome.status === 'none') return { state: outcome.reason === 'collection_failed' ? 'unavailable' : 'none', reason: NONE_REASONS[outcome.reason] ?? outcome.reason, ...empty };

  let droppedAttrs = 0;
  let dropped = diagnostics.dropped;
  const entries: FramebriarDiagnosticsEntry[] = [];
  for (const line of diagnostics.lines) {
    if (!TOKEN.test(line.ns) || !TOKEN.test(line.event) || !validAt(line.at)) {
      dropped++;
      continue;
    }
    const attrs: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(line.attrs ?? {})) {
      const mapped = key === 'exitCode' && UNOBSERVED_EXIT_CODE_EVENTS.has(line.event) ? undefined : mapAttr(key, value);
      if (mapped !== undefined && Object.keys(attrs).length < DIAGNOSTICS_LIMITS.attrsPerEntry) attrs[key] = mapped;
      else droppedAttrs++;
    }
    const operation = OPERATION_BY_EVENT.get(line.event);
    if (operation) attrs.operation = operation;
    if (line.attrs && 'exitCode' in line.attrs && attrs.exitCode === undefined && attrs.reason === undefined) attrs.reason = EXIT_CODE_UNAVAILABLE;
    entries.push({ at: line.at, level: line.level, ns: line.ns, event: line.event, ...(Object.keys(attrs).length > 0 && { attrs }) });
  }
  const mappedDelivery = mapDelivery(delivery);
  // Oldest go first, as the contract trims.
  let bytes = Buffer.byteLength(JSON.stringify(entries), 'utf-8');
  while (entries.length > DIAGNOSTICS_LIMITS.entries || bytes > DIAGNOSTICS_LIMITS.totalBytes) {
    entries.shift();
    dropped++;
    bytes = Buffer.byteLength(JSON.stringify(entries), 'utf-8');
  }
  // `attached` needs an entry: without one the contract says this.
  if (entries.length === 0) return { state: 'unavailable', reason: 'invalid', ...empty, dropped, droppedAttrs };
  return { state: 'attached', ...base, lines: entries.length, bytes, dropped, droppedAttrs, entries, ...(mappedDelivery && { delivery: mappedDelivery }) };
}
