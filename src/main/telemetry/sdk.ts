/**
 * The OpenTelemetry SDK runtime: Tracer/Meter/Logger providers wired by hand
 * (no auto-instrumentation, no resource detectors, no Azure distro).
 *
 * This module is the `telemetry-sdk` lazy chunk. Nothing in the main bundle
 * imports it statically; bootstrap.ts loads it through lazy-chunks.js only
 * when telemetry is enabled.
 */
import {
  context,
  diag,
  DiagLogLevel,
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  trace,
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Span,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BasicTracerProvider, BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  createAllowListAttributesProcessor,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import {
  ATTR,
  EVENTS,
  levelAllows,
  METRICS,
  SDK_ATTRIBUTE_KEYS,
  SPANS,
  type EventName,
  type MetricDef,
  type MetricName,
  type SpanName,
  type TelAttr,
  type TelemetryLevel,
} from '../../shared/telemetry/attributes';
import type { DestinationExporters } from './destinations/types';
import { hashId } from './ids';
import { SessionCaps } from './caps';
import { PreviewTee } from './preview-tee';
import {
  ErrorTailSpanProcessor,
  ObservedLogExporter,
  ObservedMetricExporter,
  ObservedSpanExporter,
  RedactionLogProcessor,
  RedactionSpanProcessor,
  SessionCapSpanProcessor,
  type PipelineHooks,
} from './processors';
import { classifyExportError, sanitizeAttribute } from './redaction';
import { FlowSampler } from './sampler';
import { sanitizeStack, type Scrubber } from './scrubber';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type {
  Classification,
  ExportRecord,
  EventSeverity,
  ExceptionOptions,
  FlowExtras,
  FlowOptions,
  ReplaySpan,
  SpanHandle,
  TelemetryRuntime,
} from './types';
import { ForwardedError } from './types';

export interface SdkOptions {
  level: TelemetryLevel;
  sampleRate: number;
  resourceAttributes: Attributes;
  exporters: DestinationExporters;
  hashSalt: Buffer;
  scrub: Scrubber;
  /** Local diagnostics sink for OTel/exporter warnings (never exported). */
  diagLog?: (level: 'warn' | 'error', message: string) => void;
  /** Overrides for tests. */
  metricExportIntervalMs?: number;
  batchDelayMs?: number;
  sessionCaps?: { traces: number; logs: number };
}

const SCOPE = 'clubhouse';

/** spec §6.6: appLog levels to OTel severity (App Insights severityLevel 1–4). */
const EVENT_SEVERITY: Record<EventSeverity, { number: SeverityNumber; text: string }> = {
  info: { number: SeverityNumber.INFO, text: 'INFO' },
  warn: { number: SeverityNumber.WARN, text: 'WARN' },
  error: { number: SeverityNumber.ERROR, text: 'ERROR' },
  fatal: { number: SeverityNumber.FATAL, text: 'FATAL' },
};
const METRIC_CARDINALITY_LIMIT = 200;

function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then((): void => undefined, (): void => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function';
}

function errorTypeName(error: unknown): string {
  if (error instanceof ForwardedError) {
    return /^[A-Za-z_$][\w$.]{0,63}$/.test(error.forwardedType) ? error.forwardedType : 'Error';
  }
  if (error instanceof Error) {
    const name = error.constructor?.name || error.name;
    return /^[A-Za-z_$][\w$.]{0,63}$/.test(name) ? name : 'Error';
  }
  return typeof error === 'object' && error !== null ? 'Object' : typeof error;
}

export function startSdk(opts: SdkOptions): TelemetryRuntime {
  const { scrub } = opts;
  const level = opts.level;
  // At Errors level, flow spans are still recorded so the tail processor can
  // keep the ones that fail; Detailed-only spans are never recorded below Detailed.
  const spanLevel: TelemetryLevel = level === 'errors' ? 'standard' : level;

  if (opts.diagLog) {
    const sink = opts.diagLog;
    diag.setLogger(
      {
        error: (msg) => sink('error', msg),
        warn: (msg) => sink('warn', msg),
        info: () => {},
        debug: () => {},
        verbose: () => {},
      },
      { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
    );
  }

  const contextManager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(contextManager);

  const resource = resourceFromAttributes(opts.resourceAttributes);
  const tee = new PreviewTee();

  const exportLog: ExportRecord[] = [];
  const recordExport = (signal: ExportRecord['signal'], result: ExportResult): void => {
    const err = result.error as { statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown } | undefined;
    const status = typeof err?.statusCode === 'number' ? err.statusCode : typeof err?.code === 'number' ? err.code : undefined;
    exportLog.push({
      signal,
      ok: result.code === ExportResultCode.SUCCESS,
      at: Date.now(),
      httpStatus: status,
      errorCode: typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : undefined,
      errorMessage: typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined,
    });
    if (exportLog.length > 50) exportLog.shift();
  };

  // --- Metrics ---
  // One allowlist View per registered metric. Instruments are only ever
  // created from the METRICS registry (see instrument() below), so there is
  // no unregistered instrument to drop; a catch-all DROP view would also
  // shadow these streams.
  const views = Object.entries(METRICS).map(([name, def]) => ({
    instrumentName: name,
    attributesProcessors: [createAllowListAttributesProcessor([...def.attributes])],
    aggregationCardinalityLimit: METRIC_CARDINALITY_LIMIT,
  }));
  const metricReader = new PeriodicExportingMetricReader({
    // observeHooks is defined below; it is only called after the first export.
    exporter: new ObservedMetricExporter(opts.exporters.metricExporter, {
      tee,
      onFailure: (signal, httpClass) => observeHooks.onFailure(signal, httpClass),
      onResult: (signal, result) => recordExport(signal, result),
    }),
    exportIntervalMillis: opts.metricExportIntervalMs ?? 60_000,
    exportTimeoutMillis: Math.min(30_000, opts.metricExportIntervalMs ?? 30_000),
  });
  const meterProvider = new MeterProvider({ resource, views, readers: [metricReader] });
  const meter = meterProvider.getMeter(SCOPE);
  const counters = new Map<string, Counter | Histogram | Gauge>();
  function instrument(name: MetricName): Counter | Histogram | Gauge {
    let inst = counters.get(name);
    if (!inst) {
      const def: MetricDef = METRICS[name];
      const options = { unit: def.unit, description: def.description };
      inst =
        def.kind === 'histogram'
          ? meter.createHistogram(name, options)
          : def.kind === 'gauge'
            ? meter.createGauge(name, options)
            : meter.createCounter(name, options);
      counters.set(name, inst);
    }
    return inst;
  }
  const droppedCounter = instrument('clubhouse.telemetry.dropped') as Counter;
  const failureCounter = instrument('clubhouse.telemetry.export.failures') as Counter;

  const hooks: PipelineHooks = {
    scrub,
    onDropped: (signal, n) => droppedCounter.add(n, toAttributes([ATTR.telemetrySignal(signal)])),
  };
  const caps = new SessionCaps(opts.sessionCaps, (signal) => hooks.onDropped(signal, 1));
  const observeHooks = {
    tee,
    onResult: recordExport,
    onFailure: (signal: 'traces' | 'metrics' | 'logs', httpClass: ReturnType<typeof classifyExportError>) =>
      failureCounter.add(1, toAttributes([ATTR.telemetrySignal(signal), ATTR.httpClass(httpClass)])),
  };

  // --- Traces ---
  const batchSpans = new BatchSpanProcessor(new ObservedSpanExporter(opts.exporters.spanExporter, observeHooks), {
    maxExportBatchSize: 256,
    scheduledDelayMillis: opts.batchDelayMs ?? 5000,
  });
  let spanTail: SpanProcessor = batchSpans;
  if (level === 'errors') spanTail = new ErrorTailSpanProcessor(spanTail);
  const spanPipeline = new RedactionSpanProcessor(new SessionCapSpanProcessor(spanTail, caps), hooks);
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new FlowSampler(opts.sampleRate),
    spanProcessors: [spanPipeline],
  });
  const tracer = tracerProvider.getTracer(SCOPE);

  // --- Logs ---
  const batchLogs = new BatchLogRecordProcessor({
    exporter: new ObservedLogExporter(opts.exporters.logExporter, observeHooks),
    maxExportBatchSize: 256,
    scheduledDelayMillis: opts.batchDelayMs ?? 5000,
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new RedactionLogProcessor(batchLogs, hooks, caps)],
  });
  const logger = loggerProvider.getLogger(SCOPE);

  // --- Attribute conversion ---
  // The install id goes on every span and log record so App Insights fills
  // user_Id (it ignores the resource for that); metrics never get it.
  const installId = opts.resourceAttributes['enduser.pseudo.id'];
  const userAttrs: Attributes =
    typeof installId === 'string' ? { [SDK_ATTRIBUTE_KEYS.endUserPseudoId]: installId } : {};

  function toAttributes(attrs: TelAttr[] | undefined): Attributes {
    const out: Attributes = {};
    if (!attrs) return out;
    for (const a of attrs) {
      const raw = a.kind === 'hash' ? hashId(opts.hashSalt, String(a.value)) : a.value;
      const clean = sanitizeAttribute(a.key, raw, scrub);
      if (clean !== undefined) out[a.key] = clean;
    }
    return out;
  }

  function handleFor(span: Span): SpanHandle {
    return { set: (...attrs) => span.setAttributes(toAttributes(attrs)) };
  }

  function recordException(span: Span | undefined, error: unknown, origin: ExceptionOptions): void {
    const type = errorTypeName(error);
    const stack = sanitizeStack(error instanceof Error ? error.stack : undefined, scrub) ?? `at ${type}`;
    const attributes: Attributes = {
      [SDK_ATTRIBUTE_KEYS.exceptionType]: type,
      [SDK_ATTRIBUTE_KEYS.exceptionMessage]: type,
      [SDK_ATTRIBUTE_KEYS.exceptionStacktrace]: stack,
      ...toAttributes([ATTR.exceptionOrigin(origin.origin), ATTR.exceptionHandled(origin.handled), ...(origin.attrs ?? [])]),
      ...userAttrs,
    };
    span?.addEvent('exception', attributes);
    if (levelAllows(level, EVENTS['clubhouse.exception'].level)) {
      logger.emit({
        eventName: 'clubhouse.exception',
        severityNumber: SeverityNumber.ERROR,
        severityText: 'ERROR',
        attributes,
      });
    }
  }

  function finish(span: Span, c: Classification): void {
    if (c === 'ok') {
      span.setAttributes(toAttributes([ATTR.outcome('ok')]));
    } else if ('error' in c) {
      span.setAttributes(toAttributes([ATTR.outcome('error'), ATTR.errorType(c.error)]));
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      span.setAttributes(toAttributes([ATTR.outcome(c.outcome)]));
    }
    span.end();
  }

  function runSpan<T>(
    name: SpanName,
    kind: SpanKind,
    opts2: FlowOptions,
    fn: (s: SpanHandle) => T,
    extras?: FlowExtras<T>,
  ): T {
    if (!levelAllows(spanLevel, SPANS[name].level)) return fn({ set: () => {} });
    return tracer.startActiveSpan(name, { kind, attributes: { ...toAttributes(opts2.attrs), ...userAttrs } }, (span) => {
      const classifyResult = (r: Awaited<T>): Classification => {
        if (opts2.signal?.aborted) return { outcome: 'cancelled' };
        try {
          return extras?.classify ? extras.classify(r) : 'ok';
        } catch {
          return 'ok';
        }
      };
      const onError = (err: unknown): void => {
        if (opts2.signal?.aborted) {
          finish(span, { outcome: 'cancelled' });
          return;
        }
        recordException(span, err, { origin: 'main', handled: false });
        finish(span, { error: 'unknown' });
      };
      let result: T;
      try {
        result = fn(handleFor(span));
      } catch (err) {
        onError(err);
        throw err;
      }
      if (isPromiseLike<Awaited<T>>(result)) {
        // Observe without altering the caller's promise chain.
        Promise.resolve(result).then(
          (r) => finish(span, classifyResult(r)),
          (err) => onError(err),
        );
        return result;
      }
      finish(span, classifyResult(result as Awaited<T>));
      return result;
    });
  }

  let shutDown = false;

  return {
    level,

    flow(name, flowOpts, fn, extras) {
      return runSpan(name, SPANS[name].root ? SpanKind.SERVER : SpanKind.INTERNAL, flowOpts, fn, extras);
    },

    step(name, fn, stepOpts = {}) {
      return runSpan(name, SpanKind.INTERNAL, stepOpts, fn);
    },

    count(name, value, attrs) {
      if (!levelAllows(level, METRICS[name].level)) return;
      const inst = instrument(name);
      const a = toAttributes(attrs);
      if ('add' in inst) inst.add(value, a);
      else inst.record(value, a);
    },

    event(name: EventName, attrs, opts) {
      if (!levelAllows(level, EVENTS[name].level)) return;
      const severity = EVENT_SEVERITY[opts?.severity ?? 'info'];
      logger.emit({
        eventName: name,
        severityNumber: severity.number,
        severityText: severity.text,
        attributes: { ...toAttributes(attrs), ...userAttrs, [SDK_ATTRIBUTE_KEYS.customEventName]: name },
      });
    },

    exception(error, exOpts) {
      recordException(trace.getActiveSpan(), error, exOpts);
    },

    activeTraceIds() {
      const ctx = trace.getActiveSpan()?.spanContext();
      return ctx && isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : undefined;
    },

    replaySpan(s: ReplaySpan) {
      if (!levelAllows(spanLevel, SPANS[s.name].level)) return;
      const span = tracer.startSpan(s.name, {
        kind: SPANS[s.name].root ? SpanKind.SERVER : SpanKind.INTERNAL,
        startTime: s.startMs,
        attributes: { ...toAttributes(s.attrs), ...userAttrs },
      }, context.active());
      const attrs = [ATTR.outcome(s.outcome)];
      if (s.errorType) attrs.push(ATTR.errorType(s.errorType));
      span.setAttributes(toAttributes(attrs));
      if (s.outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(s.endMs);
    },

    replayTree({ root, children }) {
      if (!levelAllows(spanLevel, SPANS[root.name].level)) return;
      const rootSpan = tracer.startSpan(root.name, {
        kind: SPANS[root.name].root ? SpanKind.SERVER : SpanKind.INTERNAL,
        startTime: root.startMs,
        attributes: { ...toAttributes(root.attrs), ...userAttrs },
      }, context.active());
      const parentCtx = trace.setSpan(context.active(), rootSpan);
      for (const c of children) {
        if (!levelAllows(spanLevel, SPANS[c.name].level)) continue;
        const child = tracer.startSpan(c.name, {
          kind: SpanKind.INTERNAL,
          startTime: c.startMs,
          attributes: { ...toAttributes(c.attrs), ...userAttrs },
        }, parentCtx);
        const cAttrs = [ATTR.outcome(c.outcome)];
        if (c.errorType) cAttrs.push(ATTR.errorType(c.errorType));
        child.setAttributes(toAttributes(cAttrs));
        if (c.outcome === 'error') child.setStatus({ code: SpanStatusCode.ERROR });
        child.end(c.endMs);
      }
      const rAttrs = [ATTR.outcome(root.outcome)];
      if (root.errorType) rAttrs.push(ATTR.errorType(root.errorType));
      rootSpan.setAttributes(toAttributes(rAttrs));
      if (root.outcome === 'error') rootSpan.setStatus({ code: SpanStatusCode.ERROR });
      rootSpan.end(root.endMs);
    },

    preview: () => tee.snapshot(),

    recentExports: (sinceMs) => exportLog.filter((r) => r.at >= sinceMs),

    async forceFlush(timeoutMs) {
      if (shutDown) return;
      await withTimeout(
        Promise.all([tracerProvider.forceFlush(), loggerProvider.forceFlush(), meterProvider.forceFlush()]),
        timeoutMs,
      );
    },

    async shutdown(timeoutMs) {
      if (shutDown) return;
      await this.forceFlush(timeoutMs);
      shutDown = true;
      await withTimeout(
        Promise.all([tracerProvider.shutdown(), loggerProvider.shutdown(), meterProvider.shutdown()]),
        timeoutMs,
      );
      context.disable();
      diag.disable();
      tee.clear();
    },
  };
}
