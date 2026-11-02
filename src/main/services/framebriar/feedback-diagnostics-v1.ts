/**
 * Framebriar's frozen report field, diagnostics v1, as Clubhouse would fill it (#2658). Not
 * sent yet: FeedbackServiceDeps.reportDiagnosticsField is off until the API is deployed and an
 * SDK that carries the field is released. Reports use the excerpt path until then. Pure.
 *
 * The contract's attrs are closed. A line's other attrs (peerRef, agentRef, driver and so
 * on) are dropped here and counted, as the service would count them.
 */
import type { FeedbackDiagnostics, FeedbackDiagnosticsOutcome } from '../../../shared/feedback-types';

export const DIAGNOSTICS_V1_LIMITS = { bytes: 64 * 1024, entries: 500, stringChars: 4096, attrs: 32 } as const;

const TOKEN = /^[A-Za-z0-9_.:+-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURES = new Set(['timeout', 'tls', 'dns', 'refused', 'closed', 'oversize', 'overflow', 'busy', 'storage', 'auth', 'protocol', 'cancelled', 'server', 'offline', 'unknown']);
const COUNTS = new Set(['attempt', 'backoffMs', 'snapshotBytes', 'webSocketMessageLimitBytes', 'transportFrameLimitBytes', 'durationMs', 'count', 'bytes', 'responseBytes', 'requestBytes', 'connectMs', 'tlsMs', 'firstByteMs']);

const inRange = (value: unknown, min: number, max: number): boolean => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

function validAttr(key: string, value: unknown): boolean {
  if (COUNTS.has(key)) return typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const text = typeof value === 'string' ? value : '';
  switch (key) {
    case 'statusCode': return inRange(value, 100, 599);
    case 'closeCode': return inRange(value, 1000, 4999);
    case 'failure': return FAILURES.has(text);
    case 'operation': return TOKEN.test(text);
    case 'connectionId':
    case 'attemptId': return UUID.test(text);
    case 'traceId': return /^[0-9a-f]{32}$/.test(text) || UUID.test(text);
    case 'spanId': return /^[0-9a-f]{16}$/.test(text);
    default: return false;
  }
}

export interface DiagnosticsV1Entry {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  ns: string;
  event: string;
  attrs?: Record<string, string | number>;
}

export interface DiagnosticsV1 {
  state: 'attached' | 'none' | 'left_out' | 'unavailable';
  reason?: string;
  windowStart: string;
  windowEnd: string;
  lines: number;
  bytes: number;
  dropped: number;
  droppedAttrs: number;
  entries: DiagnosticsV1Entry[];
  delivery?: { queued: boolean; lastResult?: string };
}

export function toDiagnosticsV1(diagnostics: FeedbackDiagnostics, outcome: FeedbackDiagnosticsOutcome): DiagnosticsV1 {
  const base = { windowStart: diagnostics.windowStart, windowEnd: diagnostics.windowEnd };
  const empty = { ...base, lines: 0, bytes: 0, dropped: 0, droppedAttrs: 0, entries: [] as DiagnosticsV1Entry[] };
  if (outcome.status === 'left_out') return { state: 'left_out', reason: outcome.reason, ...empty };
  if (outcome.status === 'none') return { state: outcome.reason === 'collection_failed' ? 'unavailable' : 'none', reason: outcome.reason, ...empty };

  let droppedAttrs = 0;
  let dropped = diagnostics.dropped;
  const entries: DiagnosticsV1Entry[] = [];
  for (const line of diagnostics.lines) {
    if (!TOKEN.test(line.ns) || !TOKEN.test(line.event)) {
      dropped++;
      continue;
    }
    const attrs: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(line.attrs ?? {})) {
      // The state a transition reached is the one state v1 has a place for.
      const name = key === 'toState' ? 'operation' : key;
      // The service wants ids in lower case.
      if (validAttr(name, value) && Object.keys(attrs).length < DIAGNOSTICS_V1_LIMITS.attrs) attrs[name] = typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : value;
      else droppedAttrs++;
    }
    entries.push({ at: line.at, level: line.level, ns: line.ns, event: line.event, ...(Object.keys(attrs).length > 0 && { attrs }) });
  }
  // Oldest go first, as the contract trims.
  let bytes = Buffer.byteLength(JSON.stringify(entries), 'utf-8');
  while (entries.length > DIAGNOSTICS_V1_LIMITS.entries || bytes > DIAGNOSTICS_V1_LIMITS.bytes) {
    entries.shift();
    dropped++;
    bytes = Buffer.byteLength(JSON.stringify(entries), 'utf-8');
  }
  return { state: 'attached', ...base, lines: entries.length, bytes, dropped, droppedAttrs, entries, delivery: { queued: true } };
}
