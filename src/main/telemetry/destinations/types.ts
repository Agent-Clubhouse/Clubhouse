import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';

/**
 * What every destination returns (spec §6.3). Each destination module is its
 * own lazy chunk so only the configured one is ever loaded.
 */
export interface DestinationExporters {
  spanExporter: SpanExporter;
  metricExporter: PushMetricExporter;
  logExporter: LogRecordExporter;
}
