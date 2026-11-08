/**
 * The local record as OpenTelemetry data (#2920, spec §6.12): the one path by
 * which recorded lines ever reach an export destination. Backfill and any other
 * replay go through `convertRecordLines` and hand its output to each
 * destination's own exporters; nothing reads record lines and sends them by hand.
 *
 * Pure: it builds SDK readable objects (spans, log records, metric data) from
 * the lines of a `telemetry-*.jsonl` run and the resource a destination exports
 * with. It never sends anything, and applies no destination level, filter or
 * limit: the caller does that.
 *
 * What never comes out:
 * - diag lines (local only by construction), and `evicted`, `dropped` and
 *   `session` lines;
 * - an event's `detail` (local only, §6.13). Its ids were hashed before they
 *   were written, so no raw id is in the record to begin with;
 * - any attribute the registry doesn't know, or whose value its format refuses:
 *   every attribute is checked again with `sanitizeAttribute`, as on export.
 *
 * Format versions: v4 session lines say the instrumentation scope and metric
 * temporality they were recorded with. v3 lines don't, and are converted on the
 * documented assumption that holds for every v3 file Clubhouse wrote: scope
 * `clubhouse` with no version, and per-window (delta) metric aggregates.
 */

import { SpanKind, SpanStatusCode, TraceFlags, ValueType, type Attributes, type HrTime, type SpanContext } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { millisToHrTime } from '@opentelemetry/core';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { AggregationTemporality, DataPointType, type MetricData, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { EVENTS, METRICS, SDK_ATTRIBUTE_KEYS, SPANS, type EventName, type MetricDef, type MetricName, type SpanName } from '../../shared/telemetry/attributes';
import { sanitizeAttribute } from './redaction';
import type { Scrubber } from './scrubber';

/** The scope every Clubhouse signal is recorded under (sdk.ts `SCOPE`). */
export const RECORD_SCOPE = 'clubhouse';
/** How the recorder aggregates metrics: one window's sum, count or last value per line. */
export const RECORD_TEMPORALITY = 'delta' as const;

export interface ReplayOptions {
  /** The resource the destination exports with (its own, so its rules on ids hold). */
  resource: Resource;
  /** The temporality the destination's metric exporter wants. */
  temporality: 'delta' | 'cumulative';
  /** The scrubber used on export, applied again to every string attribute. */
  scrub: Scrubber;
}

export interface ReplayResult {
  spans: ReadableSpan[];
  logs: ReadableLogRecord[];
  metrics: ResourceMetrics;
  /** Lines that were left out: diag, bookkeeping, unknown names, or unreadable. */
  skipped: number;
}

type Line = Record<string, unknown>;

const SEVERITY: Record<string, { number: SeverityNumber; text: string }> = {
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
  fatal: { number: SeverityNumber.FATAL, text: 'FATAL' },
};

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

function attributesOf(raw: unknown, scrub: Scrubber): Attributes {
  const out: Attributes = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const clean = sanitizeAttribute(key, value, scrub);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function hrOf(ms: unknown): HrTime | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? millisToHrTime(ms) : undefined;
}

function msOfIso(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

function contextOf(traceId: unknown, spanId: unknown): SpanContext | undefined {
  return typeof traceId === 'string' && TRACE_ID.test(traceId) && typeof spanId === 'string' && SPAN_ID.test(spanId)
    ? { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true }
    : undefined;
}

/** What a run's session line says about how it was recorded; v3 lines say nothing, so the documented assumption. */
function recordedWith(session: Line | undefined): { scope: string; temporality: 'delta' } | undefined {
  const scope = session?.scope ?? RECORD_SCOPE;
  const temporality = session?.temporality ?? RECORD_TEMPORALITY;
  // A file from a later format, or one that claims something this converter can't honour, isn't replayed.
  return scope === RECORD_SCOPE && temporality === RECORD_TEMPORALITY ? { scope, temporality } : undefined;
}

/**
 * One run's record lines (in file order, all chunks) as OpenTelemetry data for
 * one destination. Never throws: a line that can't be converted is skipped.
 */
export function convertRecordLines(lines: readonly string[], opts: ReplayOptions): ReplayResult {
  const spans: ReadableSpan[] = [];
  const logs: ReadableLogRecord[] = [];
  const metrics = new Map<string, MetricData>();
  // Cumulative running totals per series, from the run's first window.
  const totals = new Map<string, { start: HrTime; sum: number; count: number; min: number; max: number }>();
  let skipped = 0;
  let session: Line | undefined;
  let how: ReturnType<typeof recordedWith>;
  const scope = { name: RECORD_SCOPE };

  for (const text of lines) {
    let line: Line;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { skipped++; continue; }
      line = parsed as Line;
    } catch {
      skipped++;
      continue;
    }
    if (line.t === 'session') {
      session = line;
      how = recordedWith(session);
      continue;
    }
    if (!how && session === undefined) how = recordedWith(undefined);
    if (!how) { skipped++; continue; }
    try {
      if (line.t === 'span') {
        const span = spanOf(line, opts, scope);
        if (span) spans.push(span); else skipped++;
      } else if (line.t === 'event') {
        const log = eventOf(line, opts, scope);
        if (log) logs.push(log); else skipped++;
      } else if (line.t === 'exception') {
        const log = exceptionOf(line, opts, scope);
        if (log) logs.push(log); else skipped++;
      } else if (line.t === 'metric') {
        if (!addMetric(line, opts, metrics, totals)) skipped++;
      } else {
        // diag, evicted, dropped, and anything newer: never replayed.
        skipped++;
      }
    } catch {
      skipped++;
    }
  }

  return {
    spans,
    logs,
    metrics: { resource: opts.resource, scopeMetrics: metrics.size > 0 ? [{ scope, metrics: [...metrics.values()] }] : [] },
    skipped,
  };
}

function spanOf(line: Line, opts: ReplayOptions, scope: { name: string }): ReadableSpan | undefined {
  const name = line.name as SpanName;
  if (typeof name !== 'string' || !(name in SPANS)) return undefined;
  const ctx = contextOf(line.traceId, line.spanId);
  const startMs = line.startMs;
  const durationMs = line.durationMs;
  const start = hrOf(startMs);
  const duration = hrOf(durationMs);
  if (!ctx || !start || !duration || typeof startMs !== 'number' || typeof durationMs !== 'number') return undefined;
  const parent = typeof line.parentSpanId === 'string' && SPAN_ID.test(line.parentSpanId)
    ? { traceId: ctx.traceId, spanId: line.parentSpanId, traceFlags: TraceFlags.SAMPLED, isRemote: true }
    : undefined;
  const attributes = attributesOf(line.attrs, opts.scrub);
  const outcome = sanitizeAttribute('clubhouse.outcome', line.outcome, opts.scrub);
  if (outcome !== undefined) attributes['clubhouse.outcome'] = outcome;
  const errorType = line.errorType === undefined ? undefined : sanitizeAttribute('error.type', line.errorType, opts.scrub);
  if (errorType !== undefined) attributes['error.type'] = errorType;
  const spanContext: SpanContext = { ...ctx, isRemote: false };
  return {
    name,
    kind: SPANS[name].root ? SpanKind.SERVER : SpanKind.INTERNAL,
    spanContext: () => spanContext,
    parentSpanContext: parent,
    startTime: start,
    endTime: millisToHrTime(startMs + durationMs),
    status: { code: line.outcome === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET },
    attributes,
    links: [],
    events: [],
    duration,
    ended: true,
    resource: opts.resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function logOf(line: Line, opts: ReplayOptions, scope: { name: string }, eventName: string, attributes: Attributes, severity: { number: SeverityNumber; text: string }): ReadableLogRecord | undefined {
  const ms = msOfIso(line.ts);
  if (ms === undefined) return undefined;
  const time = millisToHrTime(ms);
  return {
    hrTime: time,
    hrTimeObserved: time,
    spanContext: contextOf(line.traceId, line.spanId),
    severityText: severity.text,
    severityNumber: severity.number,
    body: eventName,
    eventName,
    resource: opts.resource,
    instrumentationScope: scope,
    attributes,
    droppedAttributesCount: 0,
  };
}

function eventOf(line: Line, opts: ReplayOptions, scope: { name: string }): ReadableLogRecord | undefined {
  const name = line.name as EventName;
  // The detail (`line.detail`) is local only and is never read here.
  if (typeof name !== 'string' || !(name in EVENTS) || name === 'clubhouse.exception') return undefined;
  const attributes = { ...attributesOf(line.attrs, opts.scrub), [SDK_ATTRIBUTE_KEYS.customEventName]: name };
  return logOf(line, opts, scope, name, attributes, SEVERITY[String(line.severity)] ?? SEVERITY.info);
}

function exceptionOf(line: Line, opts: ReplayOptions, scope: { name: string }): ReadableLogRecord | undefined {
  const type = sanitizeAttribute(SDK_ATTRIBUTE_KEYS.exceptionType, line.type, opts.scrub);
  if (type === undefined) return undefined;
  const stack = typeof line.stack === 'string' ? sanitizeAttribute(SDK_ATTRIBUTE_KEYS.exceptionStacktrace, line.stack, opts.scrub) : undefined;
  const attributes: Attributes = {
    ...attributesOf(line.attrs, opts.scrub),
    [SDK_ATTRIBUTE_KEYS.exceptionType]: type,
    // App Insights needs a message; as on export, it's the type, never the real text.
    [SDK_ATTRIBUTE_KEYS.exceptionMessage]: type,
    ...(stack !== undefined && { [SDK_ATTRIBUTE_KEYS.exceptionStacktrace]: stack }),
    [SDK_ATTRIBUTE_KEYS.customEventName]: 'clubhouse.exception',
  };
  return logOf(line, opts, scope, 'clubhouse.exception', attributes, SEVERITY.error);
}

function addMetric(
  line: Line,
  opts: ReplayOptions,
  metrics: Map<string, MetricData>,
  totals: Map<string, { start: HrTime; sum: number; count: number; min: number; max: number }>,
): boolean {
  const name = line.name as MetricName;
  if (typeof name !== 'string' || !(name in METRICS)) return false;
  const def: MetricDef = METRICS[name];
  if (line.kind !== def.kind) return false;
  const startMs = line.startMs;
  const durationMs = line.durationMs;
  if (typeof startMs !== 'number' || typeof durationMs !== 'number' || !Number.isFinite(startMs) || !Number.isFinite(durationMs) || durationMs < 0) return false;
  // Only the metric's declared dimensions, as the SDK's views allow.
  const attributes = Object.fromEntries(Object.entries(attributesOf(line.attrs, opts.scrub)).filter(([k]) => def.attributes.includes(k)));
  const start = millisToHrTime(startMs);
  const end = millisToHrTime(startMs + durationMs);
  const cumulative = opts.temporality === 'cumulative' && def.kind !== 'gauge';
  const seriesKey = `${name}\u0000${JSON.stringify(Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : 1)))}`;
  const running = cumulative ? totals.get(seriesKey) ?? { start, sum: 0, count: 0, min: Infinity, max: -Infinity } : undefined;
  if (running) totals.set(seriesKey, running);

  const temporality = def.kind === 'gauge' || !cumulative ? AggregationTemporality.DELTA : AggregationTemporality.CUMULATIVE;
  const descriptor = { name, description: def.description, unit: def.unit ?? '', valueType: ValueType.DOUBLE };
  const existing = metrics.get(name);

  if (def.kind === 'counter') {
    if (typeof line.sum !== 'number' || !Number.isFinite(line.sum)) return false;
    if (running) running.sum += line.sum;
    const point = { startTime: running?.start ?? start, endTime: end, attributes, value: running ? running.sum : line.sum };
    if (existing) (existing.dataPoints as unknown[]).push(point);
    else metrics.set(name, { descriptor, aggregationTemporality: temporality, dataPointType: DataPointType.SUM, isMonotonic: true, dataPoints: [point] });
    return true;
  }
  if (def.kind === 'gauge') {
    if (typeof line.value !== 'number' || !Number.isFinite(line.value)) return false;
    const point = { startTime: start, endTime: end, attributes, value: line.value };
    if (existing) (existing.dataPoints as unknown[]).push(point);
    else metrics.set(name, { descriptor, aggregationTemporality: temporality, dataPointType: DataPointType.GAUGE, dataPoints: [point] });
    return true;
  }
  const { count, sum, min, max } = line as { count?: unknown; sum?: unknown; min?: unknown; max?: unknown };
  if (![count, sum, min, max].every((v) => typeof v === 'number' && Number.isFinite(v))) return false;
  let value = { count: count as number, sum: sum as number, min: min as number, max: max as number };
  if (running) {
    running.count += value.count;
    running.sum += value.sum;
    running.min = Math.min(running.min, value.min);
    running.max = Math.max(running.max, value.max);
    value = { count: running.count, sum: running.sum, min: running.min, max: running.max };
  }
  // The recorder keeps no buckets: one bucket holding every observation.
  const point = { startTime: running?.start ?? start, endTime: end, attributes, value: { ...value, buckets: { boundaries: [] as number[], counts: [value.count] } } };
  if (existing) (existing.dataPoints as unknown[]).push(point);
  else metrics.set(name, { descriptor, aggregationTemporality: temporality, dataPointType: DataPointType.HISTOGRAM, dataPoints: [point] });
  return true;
}
