/**
 * Destination adapters, one per kind (spec §6.11). Part of the main bundle:
 * adapters only resolve and validate settings here, and load their exporter
 * code through lazy-chunks.js when a destination of that kind starts.
 *
 * Adding a kind:
 *  1. add it to TelemetryDestinationKind / TELEMETRY_DESTINATION_KINDS
 *     (shared/telemetry/settings-types.ts) and to the
 *     `clubhouse.telemetry.destination` enum (shared/telemetry/attributes.ts);
 *  2. add an adapter below. A kind that speaks OTLP builds its exporters with
 *     `createOtlpExportersWith` (destinations/otlp.ts), passing per-signal
 *     URL and headers (headers may be async) and its temporality;
 *  3. give it a panel in TelemetrySettingsSection if it has user settings.
 * Fan-out, filters, consent, health and the per-destination test event are
 * shared.
 */
import type { TelemetryDestinationEntry, TelemetryDestinationKind } from '../../../shared/telemetry/settings-types';
import { loadAzureDestination, loadOtlpDestination } from '../lazy-chunks';
import type { TelemetrySecrets } from '../secret-store';
import {
  resolveDestination,
  validateDestination,
  type AzureDestinationConfig,
  type OtlpDestinationConfig,
  type TelemetrySettings,
} from '../settings';
import type { ExportRecord } from '../types';
import type { DestinationAdapter } from './types';

function azureFailure(record: ExportRecord): string | undefined {
  const s = record.httpStatus;
  if (s === 400) return 'Rejected (HTTP 400). Check the instrumentation key in the connection string.';
  if (s === 401 || s === 403) {
    return `Rejected (HTTP ${s}). Local authentication is probably disabled on this resource; Entra ID sign-in is not supported yet.`;
  }
  return undefined;
}

const azure: DestinationAdapter<AzureDestinationConfig> = {
  kind: 'azure',
  label: 'Azure Application Insights',
  resolve: (entry, settings, secrets) => resolveDestination(entry, settings, secrets) as AzureDestinationConfig | null,
  validate: (config) => validateDestination(config),
  async createExporters(config, _entry, ctx) {
    const { createAzureExporters } = await loadAzureDestination();
    return createAzureExporters({ connectionString: config.connectionString, storageDirectory: ctx.offlineDir });
  },
  usesOfflineQueue: true,
  describeFailure: azureFailure,
};

const otlp: DestinationAdapter<OtlpDestinationConfig> = {
  kind: 'otlp',
  label: 'OpenTelemetry (OTLP)',
  resolve: (entry, settings, secrets) => resolveDestination(entry, settings, secrets) as OtlpDestinationConfig | null,
  validate: (config) => validateDestination(config),
  async createExporters(config, entry, ctx) {
    const { createOtlpExporters } = await loadOtlpDestination();
    return createOtlpExporters({
      endpoint: config.endpoint,
      headers: config.headers,
      reservedPorts: ctx.reservedPorts,
      temporality: entry.otlp?.temporality ?? 'cumulative',
    });
  },
};

const ADAPTERS: Record<TelemetryDestinationKind, DestinationAdapter<never>> = {
  azure: azure as DestinationAdapter<never>,
  otlp: otlp as DestinationAdapter<never>,
};

export function getAdapter(kind: TelemetryDestinationKind): DestinationAdapter<unknown> {
  return ADAPTERS[kind] as DestinationAdapter<unknown>;
}

/** An entry's config and validation, together. */
export function resolveEntry(entry: TelemetryDestinationEntry, settings: TelemetrySettings, secrets: TelemetrySecrets) {
  const adapter = getAdapter(entry.kind);
  const config = adapter.resolve(entry, settings, secrets);
  const validation = config ? adapter.validate(config) : ({ ok: false, reason: 'missing_destination' } as const);
  return { adapter, config, validation };
}
