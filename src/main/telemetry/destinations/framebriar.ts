/**
 * Framebriar destination exporters (spec §6.11), loaded through lazy-chunks.js
 * when the destination starts. Framebriar speaks plain OTLP/HTTP, so this is
 * the OTLP exporter with Framebriar's URL and token, delta temporality, and
 * `session.id` on the resource: Framebriar reads the session from the resource
 * and correlates it with feedback reports. The resource is shared with the
 * other destinations, so each item gets a per-destination view, never an edit.
 */
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import type { PushMetricExporter, ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { createOtlpExportersWith } from './otlp';
import type { FramebriarTelemetryExport } from './framebriar-source';
import type { DestinationExporters } from './types';

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

export function createFramebriarExporters(config: FramebriarTelemetryExport, reservedPorts?: () => number[]): DestinationExporters {
  const exporters = createOtlpExportersWith({
    options: (signal) => config.options(signal),
    // Framebriar (Azure Monitor behind it) accepts delta metrics only.
    temporality: 'delta',
    reservedPorts,
  });
  return withSessionId(exporters, config.sessionId);
}
