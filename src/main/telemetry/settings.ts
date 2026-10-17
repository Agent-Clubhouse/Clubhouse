/**
 * Telemetry settings and the `experimental.telemetry` gate (spec §6.8).
 *
 * Non-secret settings live in `telemetry-settings.json` (0600) through the
 * TELEMETRY_SETTINGS managed-settings definition. Secrets (the connection
 * string and OTLP header values) live in `telemetry-secret.bin`, encrypted
 * with safeStorage (secret-store.ts).
 *
 * Phase 1 kept the secret in plaintext in telemetry-settings.json under a
 * `destination` object. `migrate()` converts that shape on load but keeps the
 * object as `legacyDestination` until `migrateLegacySecrets()` (after app
 * ready) has moved it into the secret store and rewritten the file without
 * it, so no save can drop the only copy.
 */
import * as fs from 'fs';
import { app } from 'electron';
import { createManagedSettings } from '../services/managed-settings';
import * as experimentalSettings from '../services/experimental-settings';
import { TELEMETRY_SETTINGS } from '../../shared/settings-definitions';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetrySettingsFile } from '../../shared/telemetry/settings-types';
import { getSecretPath, getSecureStorageState, updateSecrets, type TelemetrySecrets } from './secret-store';

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

/** The Phase 1 on-disk destination, still holding a plaintext secret. */
interface LegacyDestination {
  kind?: unknown;
  connectionString?: unknown;
  endpoint?: unknown;
  headers?: unknown;
}

export interface TelemetrySettings extends TelemetrySettingsFile {
  legacyDestination?: LegacyDestination;
}

export const DEFAULT_TELEMETRY_SETTINGS: TelemetrySettings = { ...TELEMETRY_SETTINGS.defaults };

/** Convert a Phase 1 file (destination object) to the Phase 2 shape. */
export function migrateTelemetrySettings(raw: Record<string, unknown>): TelemetrySettings {
  const settings = { ...raw } as unknown as TelemetrySettings & { destination: unknown };
  const legacy = settings.destination;
  if (legacy && typeof legacy === 'object') {
    const d = legacy as LegacyDestination;
    settings.legacyDestination = d;
    settings.destination = d.kind === 'otlp' ? 'otlp' : 'azure';
    if (d.kind === 'otlp' && typeof d.endpoint === 'string') settings.otlpEndpoint = d.endpoint;
    if (d.kind === 'otlp' && d.headers && typeof d.headers === 'object') {
      settings.otlpHeaderNames = Object.keys(d.headers as object);
    }
    // Phase 1 users configured the destination by hand in this file, so the
    // host counts as confirmed; consent is still asked for in the UI.
    if (d.kind === 'otlp' && typeof d.endpoint === 'string') {
      try {
        settings.otlpConfirmedHost = new URL(d.endpoint).host;
      } catch {
        // Invalid endpoint: validation reports it on start.
      }
    }
  } else if (legacy === null || (legacy !== 'azure' && legacy !== 'otlp')) {
    settings.destination = 'azure';
  }
  if (!TELEMETRY_LEVELS.includes(settings.level)) settings.level = 'standard';
  if (!Array.isArray(settings.otlpHeaderNames)) settings.otlpHeaderNames = [];
  if (settings.otlpTemporality !== 'delta') settings.otlpTemporality = 'cumulative';
  if (typeof settings.consentVersion !== 'number') settings.consentVersion = 0;
  return settings as TelemetrySettings;
}

const managed = createManagedSettings<TelemetrySettings>(TELEMETRY_SETTINGS as typeof TELEMETRY_SETTINGS & { defaults: TelemetrySettings }, {
  migrate: migrateTelemetrySettings,
  mode: 0o600,
});

export const getTelemetrySettings = managed.store.get;
export const updateTelemetrySettings = managed.store.update;

/** Secrets carried by a not-yet-migrated Phase 1 file. */
export function legacySecrets(settings: TelemetrySettings = getTelemetrySettings()): TelemetrySecrets {
  const d = settings.legacyDestination;
  if (!d) return {};
  const out: TelemetrySecrets = {};
  if (typeof d.connectionString === 'string') out.connectionString = d.connectionString;
  if (d.headers && typeof d.headers === 'object') {
    out.otlpHeaders = Object.fromEntries(
      Object.entries(d.headers as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
    );
  }
  return out;
}

/**
 * Move a Phase 1 plaintext secret into the secret store and wipe it from
 * telemetry-settings.json. Call after `app.whenReady()`. If secure storage is
 * unavailable the plaintext stays put (it is the only copy) and is used for
 * this run; returns false.
 */
export async function migrateLegacySecrets(): Promise<boolean> {
  const settings = getTelemetrySettings();
  if (!settings.legacyDestination) return true;
  if (getSecureStorageState() === 'unavailable') return false;
  const legacy = legacySecrets(settings);
  await updateSecrets((current) => ({
    connectionString: current.connectionString ?? legacy.connectionString,
    otlpHeaders: current.otlpHeaders ?? legacy.otlpHeaders,
  }));
  await updateTelemetrySettings((s) => {
    const next = { ...s };
    delete next.legacyDestination;
    return next;
  });
  return true;
}

/** Destination plus secrets, ready for validation and the exporters. */
export function resolveDestination(settings: TelemetrySettings, secrets: TelemetrySecrets): DestinationConfig | null {
  const merged: TelemetrySecrets = { ...legacySecrets(settings), ...secrets };
  if (settings.destination === 'azure') {
    return merged.connectionString ? { kind: 'azure', connectionString: merged.connectionString } : null;
  }
  if (!settings.otlpEndpoint) return null;
  const headers: Record<string, string> = {};
  for (const name of settings.otlpHeaderNames) {
    const value = merged.otlpHeaders?.[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return { kind: 'otlp', endpoint: settings.otlpEndpoint, headers };
}

/** Cheap, synchronous pre-check used before `ready` (no decryption). */
export function hasDestinationConfigured(settings: TelemetrySettings): boolean {
  if (settings.legacyDestination) return true;
  if (settings.destination === 'otlp') return !!settings.otlpEndpoint;
  try {
    return fs.existsSync(getSecretPath());
  } catch {
    return false;
  }
}

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

export const HEADER_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host']);
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
