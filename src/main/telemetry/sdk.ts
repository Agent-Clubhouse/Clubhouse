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
  createContextKey,
  diag,
  ROOT_CONTEXT,
  TraceFlags,
  type SpanContext,
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
import type { DestinationExporters, SdkDestination } from './destinations/types';
import { compileFilter } from './filters';
import { hashId } from './ids';
import { SessionCaps } from './caps';
import { PreviewTee } from './preview-tee';
import {
  ErrorTailSpanProcessor,
  FanOutLogProcessor,
  FanOutSpanProcessor,
  FilteredMetricExporter,
  FilterLogProcessor,
  FilterSpanProcessor,
  ObservedLogExporter,
  ObservedMetricExporter,
  ObservedSpanExporter,
  RedactionLogProcessor,
  RedactionSpanProcessor,
  SessionCapLogProcessor,
  StampLogExporter,
  StampSpanExporter,
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
  DestinationHealthRecord,
  ReplaySpan,
  SpanHandle,
  TelemetryRuntime,
} from './types';
import { errorTypeName, errorTypeOf } from './types';

export interface SdkOptions {
  /**
   * What the SDK records: the most verbose level among the destinations
   * (filters.recordingLevel). Each destination's own filter narrows it.
   */
  level: TelemetryLevel;
  sampleRate: number;
  resourceAttributes: Attributes;
  /** Every enabled destination; spans, logs and metrics fan out to each (spec §6.11). */
  destinations?: SdkDestination[];
  /** Shorthand for one destination at `level` with no preset (tests). */
  exporters?: DestinationExporters;
  hashSalt: Buffer;
  scrub: Scrubber;
  /** Local diagnostics sink for OTel/exporter warnings (never exported). */
  diagLog?: (level: 'warn' | 'error', message: string) => void;
  /**
   * Local log of export health changes (never exported): once when a destination's
   * signal starts failing and once when it recovers, not per batch.
   */
  exportLog?: (level: 'info' | 'warn', message: string, meta: Record<string, unknown>) => void;
  /** Overrides for tests. */
  metricExportIntervalMs?: number;
  /** An export with no result after this long counts as failed for health (default 30 s). */
  exportTimeoutMs?: number;
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

import { parseWireTraceparent, scoped } from './trace-context';

const REMOTE_PARENT = createContextKey('clubhouse.telemetry.remote_parent');

interface RemoteParent {
  spanContext: SpanContext;
  used: boolean;
  requestScope?: boolean;
  active?: boolean;
}


/**
 * Parse a W3C traceparent from an Annex peer. Only version 00, non-zero ids
 * and a sampled flag are accepted: an unsampled remote parent would make
 * ParentBased sampling drop this install's own spans, so this side starts its
 * own trace instead (sampled at its own rate). For a sampled parent,
 * withRemoteParent still applies this install's own rate.
 */
export function parseTraceparent(value: string): SpanContext | undefined {
  const ids = parseWireTraceparent(value);
  return ids && { ...ids, traceFlags: TraceFlags.SAMPLED, isRemote: true };
}

export function formatTraceparent(sc: SpanContext): string {
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags & TraceFlags.SAMPLED ? '01' : '00'}`;
}

export function startSdk(opts: SdkOptions): TelemetryRuntime {
  const { scrub } = opts;
  const level = opts.level;
  // Same clamp as FlowSampler: anything outside (0, 1] means record everything.
  const remoteSampleRate = opts.sampleRate > 0 && opts.sampleRate <= 1 ? opts.sampleRate : 1;
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

  const destinations: SdkDestination[] = opts.destinations ?? (opts.exporters
    ? [{ id: 'default', kind: 'default', exporters: opts.exporters, filter: { level, preset: 'all' } }]
    : []);

  const exportLog: ExportRecord[] = [];
  const health = new Map<string, DestinationHealthRecord>();
  const failingSignals = new Map<string, Map<ExportRecord['signal'], ExportRecord>>();
  const recordExport = (destination: string, signal: ExportRecord['signal'], result: ExportResult): void => {
    const err = result.error as { statusCode?: unknown; code?: unknown; name?: unknown; message?: unknown } | undefined;
    const status = typeof err?.statusCode === 'number' ? err.statusCode : typeof err?.code === 'number' ? err.code : undefined;
    const record: ExportRecord = {
      signal,
      destination,
      ok: result.code === ExportResultCode.SUCCESS,
      at: Date.now(),
      httpStatus: status,
      errorCode: typeof err?.code === 'string' ? err.code : typeof err?.name === 'string' ? err.name : undefined,
      errorMessage: typeof err?.message === 'string' ? err.message.slice(0, 300) : undefined,
    };
    exportLog.push(record);
    if (exportLog.length > 100) exportLog.shift();
    // A destination is failing while any signal's latest export failed: a
    // working metrics export doesn't hide spans that can't get through.
    const failing = failingSignals.get(destination) ?? new Map<ExportRecord['signal'], ExportRecord>();
    failingSignals.set(destination, failing);
    const h = health.get(destination) ?? {};
    const wasFailing = failing.has(signal);
    if (opts.exportLog && record.ok === wasFailing) {
      const { ok: _ok, at: _at, ...meta } = record;
      try {
        if (record.ok) opts.exportLog('info', `Telemetry export to ${destination} recovered (${signal})`, meta);
        else opts.exportLog('warn', `Telemetry export to ${destination} failing (${signal})`, meta);
      } catch { /* telemetry-exempt: a logger must never break export health */ }
    }
    if (record.ok) {
      h.lastSuccessAt = record.at;
      failing.delete(signal);
    } else {
      h.lastFailureAt = record.at;
      failing.set(signal, record);
    }
    const latest = [...failing.values()].sort((x, y) => y.at - x.at)[0];
    if (latest) h.lastFailure = latest;
    else delete h.lastFailure;
    health.set(destination, h);
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
  // observeHooks is defined below; the readers only call it after the first export.
  // One preview buffer per destination, so a busy one never pushes another's items out.
  const tees = new Map(destinations.map((d) => [d.id, new PreviewTee()]));
  const hooksFor = (dest: SdkDestination) => ({
    tee: tees.get(dest.id),
    destination: dest.id,
    exportTimeoutMs: opts.exportTimeoutMs,
    onFailure: (signal: 'traces' | 'metrics' | 'logs', httpClass: ReturnType<typeof classifyExportError>) =>
      observeHooks.onFailure(dest, signal, httpClass),
    onResult: (signal: 'traces' | 'metrics' | 'logs', result: ExportResult) => recordExport(dest.id, signal, result),
  });
  const filters = new Map(destinations.map((d) => [d.id, compileFilter(d.filter, d.id)]));
  // One reader per destination: each keeps its own temporality (from its
  // exporter) and its own filter.
  const metricReaders = destinations.map((dest) => new PeriodicExportingMetricReader({
    exporter: new FilteredMetricExporter(new ObservedMetricExporter(dest.exporters.metricExporter, hooksFor(dest)), filters.get(dest.id)!),
    exportIntervalMillis: opts.metricExportIntervalMs ?? 60_000,
    exportTimeoutMillis: Math.min(30_000, opts.metricExportIntervalMs ?? 30_000),
  }));
  const meterProvider = new MeterProvider({ resource, views, readers: metricReaders });
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
  // One budget per destination, spent after its filter (spec §6.4, §6.11).
  const capsFor = new Map(destinations.map((d) => [d.id, new SessionCaps(opts.sessionCaps, (signal) => hooks.onDropped(signal, 1))]));
  const observeHooks = {
    onFailure: (dest: SdkDestination, signal: 'traces' | 'metrics' | 'logs', httpClass: ReturnType<typeof classifyExportError>) =>
      failureCounter.add(1, toAttributes([
        ATTR.telemetrySignal(signal),
        ATTR.httpClass(httpClass),
        ATTR.telemetryDestination(dest.kind as Parameters<typeof ATTR.telemetryDestination>[0]),
      ])),
  };

  const stampFor = (dest: SdkDestination) => ({
    attributes: { 'clubhouse.telemetry.level': dest.filter.level },
    copyResourceAttributes: dest.copyResourceAttributes ?? [],
  });

  // --- Traces ---
  const spanChains = destinations.map((dest) => {
    const filter = filters.get(dest.id)!;
    const exporter = new StampSpanExporter(new ObservedSpanExporter(dest.exporters.spanExporter, hooksFor(dest)), stampFor(dest));
    let chain: SpanProcessor = new BatchSpanProcessor(exporter, {
      maxExportBatchSize: 256,
      scheduledDelayMillis: opts.batchDelayMs ?? 5000,
    });
    chain = new FilterSpanProcessor(new SessionCapSpanProcessor(chain, capsFor.get(dest.id)!), filter);
    // Before the filter, so a failing trace whose root the filter drops still
    // forwards its failing children.
    if (filter.errorTail) chain = new ErrorTailSpanProcessor(chain);
    return chain;
  });
  const spanPipeline = new RedactionSpanProcessor(new FanOutSpanProcessor(spanChains), hooks);
  const tracerProvider = new BasicTracerProvider({
    resource,
    sampler: new FlowSampler(opts.sampleRate),
    spanProcessors: [spanPipeline],
  });
  const tracer = tracerProvider.getTracer(SCOPE);

  // --- Logs ---
  const logChains = destinations.map((dest) => {
    const exporter = new StampLogExporter(new ObservedLogExporter(dest.exporters.logExporter, hooksFor(dest)), stampFor(dest));
    return new FilterLogProcessor(new SessionCapLogProcessor(new BatchLogRecordProcessor({
      exporter,
      maxExportBatchSize: 256,
      scheduledDelayMillis: opts.batchDelayMs ?? 5000,
    }), capsFor.get(dest.id)!), filters.get(dest.id)!);
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new RedactionLogProcessor(new FanOutLogProcessor(logChains), hooks)],
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

  /**
   * The parent for a root flow: a remote parent set by withRemoteParent and
   * not yet used, else ROOT_CONTEXT. Consumed once, so a callback that keeps
   * this context (a PTY spawned for a remote agent:spawn) cannot hang later
   * flows off the controller's trace.
   */
  function rootFlowParent() {
    const holder = context.active().getValue(REMOTE_PARENT) as RemoteParent | undefined;
    if (holder?.requestScope && holder.active && holder.used) return context.active();
    if (!holder || holder.used || holder.active === false) return ROOT_CONTEXT;
    holder.used = true;
    return trace.setSpanContext(ROOT_CONTEXT, holder.spanContext);
  }

  /**
   * Parent context for a replayed span, and (via SpanKind.SERVER) for a flow
   * on a registered root span: those always start a new trace, while a
   * tel.step stays under the active span whatever its name. Process and timer
   * callbacks registered inside a flow (a PTY's onExit, for example) keep that
   * flow's context for the life of the process, and a run or kill replayed
   * from there must not hang off a spawn trace that ended hours ago.
   */
  function parentFor(name: SpanName) {
    return SPANS[name].root ? ROOT_CONTEXT : context.active();
  }

  function runSpan<T>(
    name: SpanName,
    kind: SpanKind,
    opts2: FlowOptions,
    fn: (s: SpanHandle) => T,
    extras?: FlowExtras<T>,
  ): T {
    if (!levelAllows(spanLevel, SPANS[name].level)) return fn({ set: () => {} });
    return tracer.startActiveSpan(name, { kind, attributes: { ...toAttributes(opts2.attrs), ...userAttrs } }, kind === SpanKind.SERVER ? rootFlowParent() : context.active(), (span) => {
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
        finish(span, { error: errorTypeOf(err) });
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
      // Only attach to a span that is still recording. An ended span left in
      // a long-lived callback's context must not claim this exception or
      // lend its trace id to the log record.
      const active = trace.getActiveSpan();
      if (active?.isRecording()) recordException(active, error, exOpts);
      else context.with(ROOT_CONTEXT, () => recordException(undefined, error, exOpts));
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
      }, s.traceparent && parseTraceparent(s.traceparent)
        ? trace.setSpanContext(ROOT_CONTEXT, parseTraceparent(s.traceparent)!) : parentFor(s.name));
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
      }, parentFor(root.name));
      const parentCtx = trace.setSpan(ROOT_CONTEXT, rootSpan);
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

    traceparent() {
      const span = trace.getActiveSpan();
      if (!span?.isRecording()) return undefined;
      return formatTraceparent(span.spanContext());
    },

    withRemoteParent(traceparent, fn, requestScope = false) {
      const remote = parseTraceparent(traceparent);
      if (!remote) return fn();
      // ParentBased sampling would record every sampled remote trace, while
      // the spans carry this install's own microsoft.sample_rate. Make this
      // install's own decision at its own rate: kept traces continue the
      // remote one, the rest continue it unsampled (and so are dropped). Either
      // way this install records traces at exactly its configured rate.
      const keep = remoteSampleRate >= 1 || Math.random() < remoteSampleRate;
      const spanContext = keep ? remote : { ...remote, traceFlags: TraceFlags.NONE };
      const holder: RemoteParent = { spanContext, used: false, requestScope, active: true };
      return context.with(context.active().setValue(REMOTE_PARENT, holder), () =>
        scoped(fn, () => { if (requestScope) holder.active = false; }));
    },

    preview: () => [...tees.values()].flatMap((t) => t.snapshot()).sort((a, b) => a.time - b.time),

    recentExports: (sinceMs) => exportLog.filter((r) => r.at >= sinceMs),

    destinationHealth: () => Object.fromEntries([...health].map(([id, h]) => [id, { ...h }])),

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
      for (const t of tees.values()) t.clear();
    },
  };
}
