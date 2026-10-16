/**
 * Telemetry settings (`telemetry-settings.json` in userData) and the
 * `experimental.telemetry` gate.
 *
 * Phase 1 stores the destination secret (connection string / OTLP header
 * values) in this 0600 file. Phase 2 moves secrets to `safeStorage` with the
 * Settings UI; until then the whole feature sits behind the experimental flag.
 */
import { app } from 'electron';
import { createSettingsStore } from '../services/settings-store';
import * as experimentalSettings from '../services/experimental-settings';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetryIdentity } from './ids';

export const EXPERIMENTAL_FLAG = 'telemetry';

export interface AzureDestinationConfig {
  kind: 'azure';
  connectionString: string;
}

export interface OtlpDestinationConfig {
  kind: 'otlp';
  /** Base URL; `/v1/traces`, `/v1/metrics` and `/v1/logs` are appended. */
  endpoint: string;
  headers?: Record<string, string>;
}

export type DestinationConfig = AzureDestinationConfig | OtlpDestinationConfig;

export interface TelemetrySettings extends Partial<TelemetryIdentity> {
  enabled: boolean;
  level: TelemetryLevel;
  destination: DestinationConfig | null;
  /** Advanced trace sample rate in (0, 1]. */
  sampleRate: number;
  /** App version seen at the previous start, for `clubhouse.startup.kind`. */
  lastVersion?: string;
}

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = {
  enabled: false,
  level: 'standard',
  destination: null,
  sampleRate: 1,
};

const store = createSettingsStore<TelemetrySettings>(
  'telemetry-settings.json',
  DEFAULT_TELEMETRY_SETTINGS,
  undefined,
  { mode: 0o600 },
);

export const getTelemetrySettings = store.get;
export const updateTelemetrySettings = store.update;

export function isExperimentEnabled(): boolean {
  try {
    return experimentalSettings.getSettings()[EXPERIMENTAL_FLAG] === true;
  } catch {
    return false;
  }
}

// --- Destination validation -------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * App Insights ingestion host suffixes: public cloud, Azure China and Azure
 * US Government (spec §6.8). Any other host must use the Other (OTLP)
 * destination, which has its own confirmation step.
 */
export const AZURE_INGESTION_HOST_SUFFIXES = [
  '.applicationinsights.azure.com',
  '.applicationinsights.azure.cn',
  '.applicationinsights.azure.us',
  '.applicationinsights.us',
] as const;

/**
 * Test-only escape hatch so the egress test and E2E can point the Azure
 * destination at a mock on 127.0.0.1. Honoured only in unpackaged builds and
 * only for the exact `host:port` given.
 */
export const TEST_AZURE_HOST_ENV = 'CLUBHOUSE_TELEMETRY_TEST_AZURE_HOST';

export function isAllowedAzureIngestionHost(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (AZURE_INGESTION_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  const testHost = process.env[TEST_AZURE_HOST_ENV];
  return !app.isPackaged && !!testHost && url.host === testHost;
}
const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host']);
const IKEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DestinationValidation =
  | { ok: true; host: string; url: URL }
  | { ok: false; reason: string };

/**
 * HTTPS only, except plain HTTP to a literal loopback host (a local collector,
 * spec decision #8). Hostnames that merely resolve to loopback need HTTPS; the
 * OTLP destination pins `localhost` to 127.0.0.1/::1 and refuses Clubhouse's
 * own ports at connect time (destinations/otlp.ts).
 */
function validateEndpointUrl(raw: string): DestinationValidation {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (url.protocol === 'https:') return { ok: true, host: url.host, url };
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return { ok: true, host: url.host, url };
  return { ok: false, reason: 'https_required' };
}

export function parseConnectionString(connectionString: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of connectionString.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

export function validateDestination(dest: DestinationConfig | null | undefined): DestinationValidation {
  if (!dest) return { ok: false, reason: 'missing_destination' };
  if (dest.kind === 'azure') {
    if (typeof dest.connectionString !== 'string') return { ok: false, reason: 'missing_connection_string' };
    const parts = parseConnectionString(dest.connectionString);
    if (!parts.instrumentationkey || !IKEY_RE.test(parts.instrumentationkey)) {
      return { ok: false, reason: 'invalid_instrumentation_key' };
    }
    // Instrumentation-key-only ingestion was retired; the endpoint is required
    // so the exporter never falls back to its global default host.
    if (!parts.ingestionendpoint) return { ok: false, reason: 'missing_ingestion_endpoint' };
    let url: URL;
    try {
      url = new URL(parts.ingestionendpoint);
    } catch {
      return { ok: false, reason: 'invalid_url' };
    }
    if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
    // The exporter upgrades any http: endpoint to https:, so only https: is meaningful.
    if (url.protocol !== 'https:') return { ok: false, reason: 'https_required' };
    if (!isAllowedAzureIngestionHost(url)) return { ok: false, reason: 'not_azure_ingestion_host' };
    return { ok: true, host: url.host, url };
  }
  if (dest.kind === 'otlp') {
    if (typeof dest.endpoint !== 'string') return { ok: false, reason: 'missing_endpoint' };
    for (const name of Object.keys(dest.headers ?? {})) {
      if (!HEADER_TOKEN_RE.test(name)) return { ok: false, reason: 'invalid_header_name' };
      if (RESERVED_HEADERS.has(name.toLowerCase())) return { ok: false, reason: 'reserved_header_name' };
    }
    return validateEndpointUrl(dest.endpoint);
  }
  return { ok: false, reason: 'unknown_destination' };
}

export function normalizeLevel(level: unknown): TelemetryLevel {
  return TELEMETRY_LEVELS.includes(level as TelemetryLevel) ? (level as TelemetryLevel) : 'standard';
}

export function normalizeSampleRate(rate: unknown): number {
  return typeof rate === 'number' && rate > 0 && rate <= 1 ? rate : 1;
}
