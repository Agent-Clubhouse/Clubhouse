import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import type { LogRecordExporter } from '@opentelemetry/sdk-logs';
import type { TelemetryLevel } from '../../../shared/telemetry/attributes';
import type {
  OtlpTemporality,
  TelemetryDestinationEntry,
  TelemetryDestinationKind,
  TelemetryFilterPreset,
} from '../../../shared/telemetry/settings-types';
import type { TelemetrySecrets } from '../secret-store';
import type { DestinationValidation, TelemetrySettings } from '../settings';
import type { ExportRecord } from '../types';

export type TelemetrySignal = 'traces' | 'metrics' | 'logs';

/** One exporter per signal (spec §6.3). */
export interface DestinationExporters {
  spanExporter: SpanExporter;
  metricExporter: PushMetricExporter;
  logExporter: LogRecordExporter;
}

/** What one destination receives (spec §6.11). */
export interface DestinationFilter {
  level: TelemetryLevel;
  preset: TelemetryFilterPreset;
}

/**
 * A running destination as the SDK sees it. Sampling, redaction and the
 * session caps are global and happen before fan-out; everything here is per
 * destination: its filter, its batching, its exporters and its metric reader.
 */
export interface SdkDestination {
  /** Stable id (the settings entry id); tags its export records and health. */
  id: string;
  kind: string;
  exporters: DestinationExporters;
  filter: DestinationFilter;
  /**
   * Resource attribute keys to copy onto every span and log record this
   * destination receives, for backends that keep only a few resource
   * attributes. Metrics are left alone.
   */
  copyResourceAttributes?: readonly string[];
}

/** What an adapter gets from the host when it builds exporters. */
export interface DestinationContext {
  /** Azure's offline queue directory. */
  offlineDir: string;
  /** Clubhouse's own loopback ports, which plaintext OTLP must never post into. */
  reservedPorts: () => number[];
}

/**
 * Everything that differs between destination kinds. Adding a kind means
 * one adapter in registry.ts plus the kind in settings-types.ts and the
 * `clubhouse.telemetry.destination` enum; the SDK, settings, consent and UI
 * plumbing are shared.
 */
export interface DestinationAdapter<Config = unknown> {
  kind: TelemetryDestinationKind;
  /** Shown in Settings and the consent dialog. */
  label: string;
  /** Entry plus secrets into this kind's exporter config, or null when not configured yet. */
  resolve(entry: TelemetryDestinationEntry, settings: TelemetrySettings, secrets: TelemetrySecrets): Config | null;
  /** Checked in main before anything is sent; `host` is what consent names. */
  validate(config: Config): DestinationValidation;
  /** Build the exporters. Loads the kind's lazy chunk; nothing is imported until a destination of this kind is enabled. */
  createExporters(config: Config, entry: TelemetryDestinationEntry, ctx: DestinationContext): Promise<DestinationExporters>;
  /** Resource attributes to copy onto spans and log records (see SdkDestination). */
  copyResourceAttributes?: readonly string[];
  /** Items wait in a local queue when offline (Azure only today). */
  usesOfflineQueue?: boolean;
  /** Plain-words reason for a failed export, when this kind knows better than the generic text. */
  describeFailure?(record: ExportRecord): string | undefined;
}

/**
 * OTLP/HTTP exporter options for a kind whose URL and headers come from the
 * adapter rather than user fields (spec §6.11). `headers` may be async, for
 * tokens fetched or refreshed at export time.
 */
export interface OtlpExporterOptions {
  url: string;
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
}

export interface OtlpExportersInput {
  /** Per-signal URL and headers. */
  options: (signal: TelemetrySignal) => OtlpExporterOptions;
  temporality: OtlpTemporality;
  /** Plaintext HTTP is pinned to loopback and kept off these ports. */
  reservedPorts?: () => number[];
}
