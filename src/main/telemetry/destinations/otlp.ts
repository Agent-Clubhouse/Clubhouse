/**
 * Other (OTLP) destination: OTLP over HTTP/JSON (0.221.x `-http` exporters,
 * which no longer depend on protobufjs). No `-proto` / `-grpc` variants.
 * The OTLP exporters have no Statsbeat equivalent; the egress test still
 * covers them.
 */
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import type { DestinationExporters } from './types';

export interface OtlpDestinationOptions {
  /** Validated base URL (HTTPS, or HTTP to loopback). */
  endpoint: string;
  headers?: Record<string, string>;
}

export function signalUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/${signal}`;
}

export function createOtlpExporters(opts: OtlpDestinationOptions): DestinationExporters {
  const headers = { ...(opts.headers ?? {}) };
  return {
    spanExporter: new OTLPTraceExporter({ url: signalUrl(opts.endpoint, 'traces'), headers }),
    metricExporter: new OTLPMetricExporter({
      url: signalUrl(opts.endpoint, 'metrics'),
      headers,
      temporalityPreference: AggregationTemporalityPreference.DELTA,
    }),
    logExporter: new OTLPLogExporter({ url: signalUrl(opts.endpoint, 'logs'), headers }),
  };
}
