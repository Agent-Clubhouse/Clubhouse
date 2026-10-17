/**
 * Export-pipeline processors and exporter decorators. Loaded only inside the
 * SDK chunk (imported from sdk.ts).
 *
 * Sampling, redaction and the session caps are global; after them the
 * pipeline fans out to every enabled destination (spec §6.11):
 *
 * Span pipeline:  Redaction → FanOut → per destination:
 *                 [ErrorTail at Errors level] → Filter → SessionCap → Batch → Stamp → ObservedSpanExporter
 * Log pipeline:   Redaction (in place) → FanOut → per destination:
 *                 Filter → SessionCap → Batch → Stamp → ObservedLogExporter
 *
 * The error tail runs before the filter so a failing trace is kept even when
 * the filter drops its root. Session caps are per destination and counted
 * after its filter, so high-volume export to one destination never uses up
 * another's budget.
 * Metric pipeline: Views (allowlist, cardinality) → one PeriodicReader per destination →
 *                 FilteredMetricExporter → ObservedMetricExporter
 */
import { context, SpanStatusCode, type Context } from '@opentelemetry/api';
import { ExportResultCode, suppressTracing, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, Span, SpanExporter, SpanProcessor, TimedEvent } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, LogRecordProcessor, ReadableLogRecord, SdkLogRecord } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { isKnownEvent, isKnownSpan } from '../../shared/telemetry/attributes';
import { classifyExportError, sanitizeAttributes } from './redaction';
import type { Scrubber } from './scrubber';
import type { SessionCaps } from './caps';
import type { PreviewItem, PreviewTee } from './preview-tee';
import type { CompiledFilter } from './filters';

type Signal = 'traces' | 'metrics' | 'logs';

export interface PipelineHooks {
  scrub: Scrubber;
  /** An item was dropped by redaction or a cap. */
  onDropped(signal: Signal, count: number): void;
}

// --- Spans ------------------------------------------------------------------

/** A redacted, frozen copy of a finished span. */
function redactSpan(span: ReadableSpan, scrub: Scrubber): ReadableSpan {
  const { attributes } = sanitizeAttributes(span.attributes, scrub);
  const events: TimedEvent[] = span.events
    .filter((e) => e.name === 'exception')
    .map((e) => ({
      name: e.name,
      time: e.time,
      droppedAttributesCount: 0,
      attributes: sanitizeAttributes(e.attributes, scrub).attributes,
    }));
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => spanContext,
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    // Status messages can carry error text; only the code survives.
    status: { code: span.status.code },
    attributes,
    links: span.links.map((l) => ({ context: l.context })),
    events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

abstract class ForwardingSpanProcessor implements SpanProcessor {
  constructor(protected readonly next: SpanProcessor) {}
  onStart(span: Span, parentContext: Context): void {
    this.next.onStart(span, parentContext);
  }
  abstract onEnd(span: ReadableSpan): void;
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

export class RedactionSpanProcessor extends ForwardingSpanProcessor {
  constructor(next: SpanProcessor, private readonly hooks: PipelineHooks) {
    super(next);
  }
  onEnd(span: ReadableSpan): void {
    if (!isKnownSpan(span.name)) {
      this.hooks.onDropped('traces', 1);
      return;
    }
    this.next.onEnd(redactSpan(span, this.hooks.scrub));
  }
}

export class SessionCapSpanProcessor extends ForwardingSpanProcessor {
  constructor(next: SpanProcessor, private readonly caps: SessionCaps) {
    super(next);
  }
  onEnd(span: ReadableSpan): void {
    if (this.caps.tryAcquire('traces')) this.next.onEnd(span);
  }
}

/**
 * Errors level (spec §6.4): buffer each trace until its local root ends and
 * export it only if some span in it ended in ERROR.
 */
export class ErrorTailSpanProcessor extends ForwardingSpanProcessor {
  private readonly traces = new Map<string, ReadableSpan[]>();

  constructor(
    next: SpanProcessor,
    private readonly maxSpansPerTrace = 64,
    private readonly maxOpenTraces = 256,
  ) {
    super(next);
  }

  onEnd(span: ReadableSpan): void {
    const traceId = span.spanContext().traceId;
    let buffer = this.traces.get(traceId);
    if (!buffer) {
      if (this.traces.size >= this.maxOpenTraces) {
        const oldest = this.traces.keys().next().value;
        if (oldest !== undefined) this.traces.delete(oldest);
      }
      buffer = [];
      this.traces.set(traceId, buffer);
    }
    const isLocalRoot = !span.parentSpanContext || span.parentSpanContext.isRemote === true;
    if (buffer.length < this.maxSpansPerTrace - 1 || isLocalRoot) buffer.push(span);
    if (!isLocalRoot) return;

    this.traces.delete(traceId);
    if (buffer.some((s) => s.status.code === SpanStatusCode.ERROR)) {
      for (const s of buffer) this.next.onEnd(s);
    }
  }

  pendingTraceCount(): number {
    return this.traces.size;
  }
}

/** Hands every span to each destination's chain. */
export class FanOutSpanProcessor implements SpanProcessor {
  constructor(private readonly children: SpanProcessor[]) {}
  onStart(span: Span, parentContext: Context): void {
    for (const c of this.children) c.onStart(span, parentContext);
  }
  onEnd(span: ReadableSpan): void {
    for (const c of this.children) c.onEnd(span);
  }
  async forceFlush(): Promise<void> {
    // One destination failing must not cut another's flush short.
    await Promise.allSettled(this.children.map((c) => c.forceFlush()));
  }
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.children.map((c) => c.shutdown()));
  }
}

/** One destination's filter: spans it doesn't take never reach its batch. */
export class FilterSpanProcessor extends ForwardingSpanProcessor {
  constructor(next: SpanProcessor, private readonly filter: CompiledFilter) {
    super(next);
  }
  onEnd(span: ReadableSpan): void {
    if (this.filter.span({ name: span.name, attributes: span.attributes, isError: span.status.code === SpanStatusCode.ERROR })) {
      this.next.onEnd(span);
    }
  }
}

// --- Logs -------------------------------------------------------------------

export class RedactionLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly next: LogRecordProcessor,
    private readonly hooks: PipelineHooks,
    /** Optional: the multi-destination pipeline caps per destination instead (SessionCapLogProcessor). */
    private readonly caps?: SessionCaps,
  ) {}

  onEmit(record: SdkLogRecord, ctx?: Context): void {
    const eventName = record.eventName;
    if (!eventName || !isKnownEvent(eventName)) {
      this.hooks.onDropped('logs', 1);
      return;
    }
    const { attributes } = sanitizeAttributes(record.attributes, this.hooks.scrub);
    // The SDK record's attribute bag is a plain object; rewrite it in place
    // so downstream processors and the exporter only see registry keys.
    const bag = record.attributes as Record<string, unknown>;
    for (const key of Object.keys(bag)) delete bag[key];
    Object.assign(bag, attributes);
    // Body is always the event name, never a message.
    record.setBody(eventName);
    if (this.caps && !this.caps.tryAcquire('logs')) return;
    this.next.onEmit(record, ctx);
  }

  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/** Hands every (already redacted) log record to each destination's chain. */
export class FanOutLogProcessor implements LogRecordProcessor {
  constructor(private readonly children: LogRecordProcessor[]) {}
  onEmit(record: SdkLogRecord, ctx?: Context): void {
    for (const c of this.children) c.onEmit(record, ctx);
  }
  async forceFlush(): Promise<void> {
    // One destination failing must not cut another's flush short.
    await Promise.allSettled(this.children.map((c) => c.forceFlush()));
  }
  async shutdown(): Promise<void> {
    await Promise.allSettled(this.children.map((c) => c.shutdown()));
  }
}

export class FilterLogProcessor implements LogRecordProcessor {
  constructor(private readonly next: LogRecordProcessor, private readonly filter: CompiledFilter) {}
  onEmit(record: SdkLogRecord, ctx?: Context): void {
    if (this.filter.log({ name: record.eventName ?? '', attributes: record.attributes })) this.next.onEmit(record, ctx);
  }
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

/** One destination's log budget for the session. */
export class SessionCapLogProcessor implements LogRecordProcessor {
  constructor(private readonly next: LogRecordProcessor, private readonly caps: SessionCaps) {}
  onEmit(record: SdkLogRecord, ctx?: Context): void {
    if (this.caps.tryAcquire('logs')) this.next.onEmit(record, ctx);
  }
  forceFlush(): Promise<void> {
    return this.next.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.next.shutdown();
  }
}

// --- Exporter decorators ----------------------------------------------------

export interface ObserveHooks {
  tee?: PreviewTee;
  /**
   * An export with no result after this long is recorded as a failure (so a
   * hanging destination shows as failing). The real result, if it ever
   * arrives, is still recorded. Default 30 s.
   */
  exportTimeoutMs?: number;
  /** The destination these exports go to; tags preview items. */
  destination?: string;
  onFailure(signal: Signal, httpClass: ReturnType<typeof classifyExportError>): void;
  /** Every export result, success or failure (the Settings test event reads these). */
  onResult?(signal: Signal, result: ExportResult): void;
}

function hrToMs(t: [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}

export const DEFAULT_EXPORT_TIMEOUT_MS = 30_000;

function observe(signal: Signal, hooks: ObserveHooks, cb: (r: ExportResult) => void): (r: ExportResult) => void {
  const timer = setTimeout(() => {
    const error = Object.assign(new Error('Export timed out'), { code: 'ETIMEDOUT' });
    hooks.onFailure(signal, classifyExportError(error));
    hooks.onResult?.(signal, { code: ExportResultCode.FAILED, error });
  }, hooks.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS);
  timer.unref?.();
  return (result) => {
    clearTimeout(timer);
    if (result.code !== ExportResultCode.SUCCESS) hooks.onFailure(signal, classifyExportError(result.error));
    hooks.onResult?.(signal, result);
    cb(result);
  };
}

function scalarAttrs(attrs: Record<string, unknown>): PreviewItem['attributes'] {
  const out: PreviewItem['attributes'] = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Exporter calls never generate spans of their own (spec §6.1). */
function suppressed<T>(fn: () => T): T {
  return context.with(suppressTracing(context.active()), fn);
}

export class ObservedSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter, private readonly hooks: ObserveHooks) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const s of spans) {
      this.hooks.tee?.push({ signal: 'traces', destination: this.hooks.destination, name: s.name, time: hrToMs(s.startTime), attributes: scalarAttrs(s.attributes) });
    }
    suppressed(() => this.inner.export(spans, observe('traces', this.hooks, resultCallback)));
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class ObservedLogExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter, private readonly hooks: ObserveHooks) {}
  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    for (const l of logs) {
      this.hooks.tee?.push({ signal: 'logs', destination: this.hooks.destination, name: l.eventName ?? '', time: hrToMs(l.hrTime), attributes: scalarAttrs(l.attributes) });
    }
    suppressed(() => this.inner.export(logs, observe('logs', this.hooks, resultCallback)));
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class ObservedMetricExporter implements PushMetricExporter {
  constructor(private readonly inner: PushMetricExporter, private readonly hooks: ObserveHooks) {
    // The reader asks the exporter for its temporality and aggregation
    // preferences; forward them so Azure keeps its delta temporality.
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = inner.selectAggregation.bind(inner);
    }
  }
  selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  selectAggregation?: PushMetricExporter['selectAggregation'];

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    for (const scope of metrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const dp of metric.dataPoints as Array<{ attributes: Record<string, unknown>; value: unknown; endTime: [number, number] }>) {
          this.hooks.tee?.push({
            signal: 'metrics',
            destination: this.hooks.destination,
            name: metric.descriptor.name,
            time: hrToMs(dp.endTime),
            attributes: scalarAttrs(dp.attributes),
            value: typeof dp.value === 'number' ? dp.value : undefined,
          });
        }
      }
    }
    suppressed(() => this.inner.export(metrics, observe('metrics', this.hooks, resultCallback)));
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}


// --- Per-destination exporter decorators --------------------------------------

/**
 * What a destination adds to every span and log record it receives: its own
 * `clubhouse.telemetry.level` (the resource can only carry one value), and
 * any resource attributes it copies onto items for backends that keep few
 * resource attributes.
 */
export interface DestinationStamp {
  attributes: Record<string, string>;
  copyResourceAttributes: readonly string[];
}

function stampAttributes(
  attrs: Record<string, unknown>,
  resource: { attributes: Record<string, unknown> },
  stamp: DestinationStamp,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...attrs };
  for (const k of stamp.copyResourceAttributes) {
    const v = resource.attributes[k];
    if (v !== undefined && !(k in out)) out[k] = v;
  }
  for (const [k, v] of Object.entries(stamp.attributes)) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Per-destination copy of a shared span. A plain object with every
 * ReadableSpan field, so exporters that spread, clone or serialize it keep
 * the stamped attributes, and other destinations keep seeing the original.
 */
function stampSpan(span: ReadableSpan, stamp: DestinationStamp): ReadableSpan {
  const spanContext = span.spanContext();
  return {
    name: span.name,
    kind: span.kind,
    spanContext: () => spanContext,
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: span.status,
    attributes: stampAttributes(span.attributes, span.resource, stamp) as ReadableSpan['attributes'],
    links: span.links,
    events: span.events,
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  };
}

/** Per-destination copy of a shared log record (see stampSpan). */
function stampLog(log: ReadableLogRecord, stamp: DestinationStamp): ReadableLogRecord {
  return {
    hrTime: log.hrTime,
    hrTimeObserved: log.hrTimeObserved,
    spanContext: log.spanContext,
    severityText: log.severityText,
    severityNumber: log.severityNumber,
    body: log.body,
    eventName: log.eventName,
    resource: log.resource,
    instrumentationScope: log.instrumentationScope,
    attributes: stampAttributes(log.attributes, log.resource, stamp) as ReadableLogRecord['attributes'],
    droppedAttributesCount: log.droppedAttributesCount,
  };
}

export class StampSpanExporter implements SpanExporter {
  constructor(private readonly inner: SpanExporter, private readonly stamp: DestinationStamp) {}
  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(spans.map((s) => stampSpan(s, this.stamp)), resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export class StampLogExporter implements LogRecordExporter {
  constructor(private readonly inner: LogRecordExporter, private readonly stamp: DestinationStamp) {}
  export(logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(logs.map((l) => stampLog(l, this.stamp)), resultCallback);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/**
 * One destination's metric filter. Each destination has its own reader, so
 * this only drops whole metric streams it doesn't take; temporality and
 * aggregation preferences come from the wrapped exporter.
 */
export class FilteredMetricExporter implements PushMetricExporter {
  constructor(private readonly inner: PushMetricExporter, private readonly filter: CompiledFilter) {
    if (inner.selectAggregationTemporality) {
      this.selectAggregationTemporality = inner.selectAggregationTemporality.bind(inner);
    }
    if (inner.selectAggregation) {
      this.selectAggregation = inner.selectAggregation.bind(inner);
    }
  }
  selectAggregationTemporality?: PushMetricExporter['selectAggregationTemporality'];
  selectAggregation?: PushMetricExporter['selectAggregation'];

  export(metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void): void {
    const scopeMetrics = metrics.scopeMetrics
      .map((scope) => ({ ...scope, metrics: scope.metrics.filter((m) => this.filter.metric(m.descriptor.name)) }))
      .filter((scope) => scope.metrics.length > 0);
    if (scopeMetrics.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }
    this.inner.export({ ...metrics, scopeMetrics }, resultCallback);
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
