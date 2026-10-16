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
  trace,
  type Attributes,
  type Counter,
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
import type {
  Classification,
  ExceptionOptions,
  FlowExtras,
  FlowOptions,
  ReplaySpan,
  SpanHandle,
  TelemetryRuntime,
} from './types';

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
    }),
    exportIntervalMillis: opts.metricExportIntervalMs ?? 60_000,
    exportTimeoutMillis: Math.min(30_000, opts.metricExportIntervalMs ?? 30_000),
  });
  const meterProvider = new MeterProvider({ resource, views, readers: [metricReader] });
  const meter = meterProvider.getMeter(SCOPE);
  const counters = new Map<string, Counter | Histogram>();
  function instrument(name: MetricName): Counter | Histogram {
    let inst = counters.get(name);
    if (!inst) {
      const def: MetricDef = METRICS[name];
      const options = { unit: def.unit, description: def.description };
      inst = def.kind === 'histogram' ? meter.createHistogram(name, options) : meter.createCounter(name, options);
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
      ...toAttributes([ATTR.exceptionOrigin(origin.origin), ATTR.exceptionHandled(origin.handled)]),
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
    return tracer.startActiveSpan(name, { kind, attributes: toAttributes(opts2.attrs) }, (span) => {
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

    event(name: EventName, attrs) {
      if (!levelAllows(level, EVENTS[name].level)) return;
      logger.emit({
        eventName: name,
        severityNumber: SeverityNumber.INFO,
        severityText: 'INFO',
        attributes: { ...toAttributes(attrs), [SDK_ATTRIBUTE_KEYS.customEventName]: name },
      });
    },

    exception(error, exOpts) {
      recordException(trace.getActiveSpan(), error, exOpts);
    },

    replaySpan(s: ReplaySpan) {
      if (!levelAllows(spanLevel, SPANS[s.name].level)) return;
      const span = tracer.startSpan(s.name, {
        kind: SPANS[s.name].root ? SpanKind.SERVER : SpanKind.INTERNAL,
        startTime: s.startMs,
        attributes: toAttributes(s.attrs),
      }, context.active());
      const attrs = [ATTR.outcome(s.outcome)];
      if (s.errorType) attrs.push(ATTR.errorType(s.errorType));
      span.setAttributes(toAttributes(attrs));
      if (s.outcome === 'error') span.setStatus({ code: SpanStatusCode.ERROR });
      span.end(s.endMs);
    },

    preview: () => tee.snapshot(),

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
