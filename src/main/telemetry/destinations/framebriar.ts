/**
 * Framebriar destination exporters (spec §6.11), loaded through lazy-chunks.js
 * when the destination starts. Framebriar speaks plain OTLP/HTTP, so this is
 * the OTLP exporter with Framebriar's URL and token, delta temporality, and
 * `session.id` on the resource: Framebriar reads the session from the resource
 * and correlates it with feedback reports. The resource is shared with the
 * other destinations, so each item gets a per-destination view, never an edit.
 *
 * Every export first reads the live source: with Feedback disconnected, switched
 * off, in a different session, or without a token, the batch fails locally and
 * nothing is sent.
 */
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { createOtlpExportersWith } from './otlp';
import { FRAMEBRIAR_NOT_CONNECTED, type FramebriarTelemetryExport } from './framebriar-source';
import type { DestinationExporters, TelemetrySignal } from './types';

type ResourceLike = { attributes: Record<string, unknown> };

/** One view per shared resource, so the OTLP serializer still groups items by resource. */
export function sessionResourceView(sessionId: string): <R extends ResourceLike>(resource: R) => R {
  const views = new WeakMap<object, ResourceLike>();
  return <R extends ResourceLike>(resource: R): R => {
    let view = views.get(resource);
    if (!view) {
      view = Object.create(resource, {
        attributes: { value: { ...resource.attributes, 'session.id': sessionId }, enumerable: true },
      }) as ResourceLike;
      views.set(resource, view);
    }
    return view as R;
  };
}

const withResource = <T extends { resource: ResourceLike }>(item: T, resource: ResourceLike): T =>
  Object.create(item, { resource: { value: resource, enumerable: true } }) as T;

export function withSessionId(exporters: DestinationExporters, sessionId: string): DestinationExporters {
  const view = sessionResourceView(sessionId);
  const { spanExporter, logExporter, metricExporter } = exporters;
  const spans: SpanExporter = {
    export: (items: ReadableSpan[], cb: (r: ExportResult) => void) =>
      spanExporter.export(items.map((s) => withResource(s as ReadableSpan & { resource: ResourceLike }, view(s.resource as unknown as ResourceLike))), cb),
    shutdown: () => spanExporter.shutdown(),
    forceFlush: () => spanExporter.forceFlush?.() ?? Promise.resolve(),
  };
  const logs: LogRecordExporter = {
    export: (items: ReadableLogRecord[], cb: (r: ExportResult) => void) =>
      logExporter.export(items.map((l) => withResource(l as ReadableLogRecord & { resource: ResourceLike }, view(l.resource as unknown as ResourceLike))), cb),
    shutdown: () => logExporter.shutdown(),
    forceFlush: () => logExporter.forceFlush?.() ?? Promise.resolve(),
  };
  const metrics: PushMetricExporter = {
    export: (rm: ResourceMetrics, cb: (r: ExportResult) => void) =>
      metricExporter.export({ ...rm, resource: view(rm.resource as unknown as ResourceLike) as unknown as ResourceMetrics['resource'] }, cb),
    forceFlush: () => metricExporter.forceFlush(),
    shutdown: () => metricExporter.shutdown(),
    ...(metricExporter.selectAggregationTemporality
      ? { selectAggregationTemporality: metricExporter.selectAggregationTemporality.bind(metricExporter) }
      : {}),
    ...(metricExporter.selectAggregation
      ? { selectAggregation: metricExporter.selectAggregation.bind(metricExporter) }
      : {}),
  };
  return { spanExporter: spans, logExporter: logs, metricExporter: metrics };
}

type Authorize = (signal: TelemetrySignal) => Promise<boolean>;

const notConnected = (cb: (r: ExportResult) => void) => cb({ code: ExportResultCode.FAILED, error: new Error(FRAMEBRIAR_NOT_CONNECTED) });

/** Exports only after `authorize` passes for that signal; otherwise fails the batch without sending it. */
export function gated(exporters: DestinationExporters, authorize: Authorize): DestinationExporters {
  const { spanExporter, logExporter, metricExporter } = exporters;
  const run = <T>(signal: TelemetrySignal, send: (items: T, cb: (r: ExportResult) => void) => void) =>
    (items: T, cb: (r: ExportResult) => void) => {
      authorize(signal).then(
        (ok) => (ok ? send(items, cb) : notConnected(cb)),
        () => notConnected(cb),
      );
    };
  return {
    spanExporter: { ...bindAll(spanExporter), export: run('traces', spanExporter.export.bind(spanExporter)) },
    logExporter: { ...bindAll(logExporter), export: run('logs', logExporter.export.bind(logExporter)) },
    metricExporter: { ...bindAll(metricExporter), export: run('metrics', metricExporter.export.bind(metricExporter)) },
  };
}

/** The exporter's other methods, bound, so the gated copy behaves the same. */
function bindAll<T extends object>(exporter: T): T {
  const out: Record<string, unknown> = {};
  for (const key of ['shutdown', 'forceFlush', 'selectAggregationTemporality', 'selectAggregation'] as const) {
    const fn = (exporter as Record<string, unknown>)[key];
    if (typeof fn === 'function') out[key] = fn.bind(exporter);
  }
  return out as T;
}

/**
 * The per-export check: `live` must still name this exporter's host and session
 * and yield a token. `headers` returns what the last passing check fetched, which
 * is all the OTLP exporter ever sends.
 */
export function framebriarAuthorizer(config: FramebriarTelemetryExport, live: () => FramebriarTelemetryExport | null) {
  const checked: Partial<Record<TelemetrySignal, Record<string, string>>> = {};
  // Only a batch that passed the check is ever sent, so the last checked headers are current.
  const authorize: Authorize = async (signal) => {
    const now = live();
    if (!now || now.host !== config.host || now.sessionId !== config.sessionId) return false;
    const headers = await now.options(signal).headers();
    if (!headers.authorization) return false;
    checked[signal] = headers;
    return true;
  };
  return { authorize, headers: (signal: TelemetrySignal) => checked[signal] ?? {} };
}

export function createFramebriarExporters(
  config: FramebriarTelemetryExport,
  reservedPorts?: () => number[],
  live: () => FramebriarTelemetryExport | null = () => config,
): DestinationExporters {
  const auth = framebriarAuthorizer(config, live);
  const exporters = createOtlpExportersWith({
    options: (signal) => ({ url: config.options(signal).url, headers: async () => auth.headers(signal) }),
    // Framebriar (Azure Monitor behind it) accepts delta metrics only.
    temporality: 'delta',
    reservedPorts,
  });
  return gated(withSessionId(exporters, config.sessionId), auth.authorize);
}
