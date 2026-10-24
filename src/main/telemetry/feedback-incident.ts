/** Bounded, memory-only Annex references. No messages, URLs, stable identities or exporter secrets. */
import { randomUUID } from 'crypto';
import { currentTraceparent, getRecordingGeneration, isTelemetryActive } from './facade';
import { parseWireTraceparent } from './trace-context';
import { telemetryInstanceId } from './instance';
import type { FramebriarIncident, FramebriarSnapshot } from '../vendor/framebriar/adapters/node/index.mjs';
import type { FeedbackCorrelationSummary } from '../../shared/feedback-types';

const WINDOW_MS = 300_000;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Ref = { traceId: string; spanId: string; at: number; generation: number };
type Peer = { phone: string; connection: string; at: number; generation: number };
const refs: Ref[] = [];
const peers: Peer[] = [];
let peersOverflowUntil = 0;

function prune(now: number): void {
  const generation = getRecordingGeneration();
  for (const list of [refs, peers]) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isTelemetryActive() || list[i].generation !== generation || now - list[i].at > WINDOW_MS || list[i].at > now) list.splice(i, 1);
    }
  }
  if (peers.length === 0) peersOverflowUntil = 0;
}

export function rememberAnnexIncidentTrace(now = Date.now()): void {
  prune(now);
  if (!isTelemetryActive()) return;
  const trace = parseWireTraceparent(currentTraceparent());
  if (!trace) return;
  const previous = refs.findIndex(r => r.traceId === trace.traceId && r.spanId === trace.spanId);
  if (previous >= 0) refs.splice(previous, 1);
  refs.push({ ...trace, at: now, generation: getRecordingGeneration() });
  if (refs.length > 32) refs.shift();
}

/** Call only after the mTLS hello has been validated. Peer claims never become local identity. */
export function rememberAnnexIncidentPhone(service: string, phone: string, connection: string, now = Date.now()): void {
  prune(now);
  if (!isTelemetryActive() || service !== 'clubhouse-go' || phone.length !== 36 || connection.length !== 36 || !UUID4.test(phone) || !UUID4.test(connection)) return;
  const previous = peers.findIndex(p => p.connection === connection);
  if (previous >= 0) peers.splice(previous, 1);
  peers.push({ phone, connection, at: now, generation: getRecordingGeneration() });
  if (peers.length > 32) { peers.shift(); peersOverflowUntil = now + WINDOW_MS; }
}

export interface FeedbackCorrelationSnapshot {
  data: Pick<FramebriarSnapshot, 'capturedAt' | 'traceId' | 'spanId' | 'incident'>;
  summary?: FeedbackCorrelationSummary;
}

/** Synchronous snapshot at feedback opening, before startup/capture/review can change context. */
export function captureFeedbackCorrelation(now = Date.now()): FeedbackCorrelationSnapshot {
  rememberAnnexIncidentTrace(now);
  const capturedAt = new Date(now).toISOString();
  const traces = refs.slice(-8).reverse().map(({ traceId, spanId }) => Object.freeze({ traceId, spanId }));
  const phones = [...new Set(peers.map(p => p.phone))];
  const first = traces[0];
  // v1 requires one real phone. No phone or ambiguous multiple phones uses the
  // upstream-documented legacy pair instead of inventing/misattributing identity.
  let incident: FramebriarIncident | undefined;
  if (phones.length === 1 && peersOverflowUntil <= now) {
    incident = Object.freeze({
      version: 1, id: randomUUID(), capturedAt, windowEnd: capturedAt,
      windowStart: new Date(Math.max(now - WINDOW_MS, Math.min(now, ...refs.map(r => r.at), ...peers.map(p => p.at)))).toISOString(),
      availability: first ? 'recorded' : 'unavailable', phoneInstanceId: phones[0],
      hostInstanceIds: Object.freeze([telemetryInstanceId]),
      connectionIds: Object.freeze([...new Set(peers.filter(p => p.phone === phones[0]).map(p => p.connection))].slice(-4)),
      traces: Object.freeze(traces),
    });
  }
  return {
    data: Object.freeze({ capturedAt, ...(first ?? {}), ...(incident && { incident }) }),
    ...((first || incident) && { summary: Object.freeze({
      scope: incident ? 'incident' as const : 'trace-only' as const, capturedAt,
      traceCount: incident ? traces.length : 1, hostCount: incident ? 1 : 0,
      phoneCount: incident ? 1 : 0, connectionCount: incident?.connectionIds.length ?? 0,
    }) }),
  };
}

export function _resetFeedbackIncidentForTests(): void { refs.length = 0; peers.length = 0; peersOverflowUntil = 0; }
