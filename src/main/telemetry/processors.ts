/**
 * Export-pipeline processors and exporter decorators. Loaded only inside the
 * SDK chunk (imported from sdk.ts).
 *
 * Span pipeline:  Redaction → SessionCap → [ErrorTail at Errors level] → Batch → ObservedSpanExporter → destination
 * Log pipeline:   Redaction (in place) → SessionCap → Batch → ObservedLogExporter → destination
 * Metric pipeline: Views (allowlist, cardinality) → PeriodicReader → ObservedMetricExporter → destination
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

// --- Logs -------------------------------------------------------------------

export class RedactionLogProcessor implements LogRecordProcessor {
  constructor(
    private readonly next: LogRecordProcessor,
    private readonly hooks: PipelineHooks,
    private readonly caps: SessionCaps,
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
    if (!this.caps.tryAcquire('logs')) return;
    this.next.onEmit(record, ctx);
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
  onFailure(signal: Signal, httpClass: ReturnType<typeof classifyExportError>): void;
  /** Every export result, success or failure (the Settings test event reads these). */
  onResult?(signal: Signal, result: ExportResult): void;
}

function hrToMs(t: [number, number]): number {
  return t[0] * 1000 + t[1] / 1e6;
}

function observe(signal: Signal, hooks: ObserveHooks, cb: (r: ExportResult) => void): (r: ExportResult) => void {
  return (result) => {
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
      this.hooks.tee?.push({ signal: 'traces', name: s.name, time: hrToMs(s.startTime), attributes: scalarAttrs(s.attributes) });
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
      this.hooks.tee?.push({ signal: 'logs', name: l.eventName ?? '', time: hrToMs(l.hrTime), attributes: scalarAttrs(l.attributes) });
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

