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
 *
 * Phase 2 had one active destination (`enabled` + `destination` + `level`
 * and flat `otlp*` fields). Since multi-destination export, the file holds a
 * `destinations` list, one entry per kind, each with its own switch, level
 * and preset; `migrate()` converts the Phase 2 shape with no change in what
 * is sent.
 */
import * as fs from 'fs';
import { app } from 'electron';
import { createManagedSettings } from '../services/managed-settings';
import * as experimentalSettings from '../services/experimental-settings';
import { TELEMETRY_SETTINGS } from '../../shared/settings-definitions';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import {
  TELEMETRY_DESTINATION_KINDS,
  TELEMETRY_FILTER_PRESETS,
  type OtlpTemporality,
  type TelemetryDestinationEntry,
  type TelemetryDestinationKind,
  type TelemetrySettingsFile,
} from '../../shared/telemetry/settings-types';
import { getSecretPath, getSecureStorageState, updateSecrets, type TelemetrySecrets } from './secret-store';
import { getFramebriarTelemetrySource } from './destinations/framebriar-source';

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

/** The Phase 2 flat fields, before the destinations list. */
interface Phase2Fields {
  enabled?: unknown;
  destination?: unknown;
  level?: unknown;
  otlpEndpoint?: unknown;
  otlpHeaderNames?: unknown;
  otlpTemporality?: unknown;
  otlpConfirmedHost?: unknown;
}

const PHASE2_KEYS: Array<keyof Phase2Fields> = [
  'enabled', 'destination', 'level', 'otlpEndpoint', 'otlpHeaderNames', 'otlpTemporality', 'otlpConfirmedHost',
];

function defaultEntry(kind: TelemetryDestinationKind): TelemetryDestinationEntry {
  const entry: TelemetryDestinationEntry = { id: kind, kind, enabled: false, level: 'standard', preset: 'all' };
  if (kind === 'otlp') entry.otlp = { endpoint: '', headerNames: [], temporality: 'cumulative' };
  // The developer's feedback service gets "User activity and errors" only.
  if (kind === 'framebriar') {
    entry.preset = 'user_activity';
    entry.framebriar = { autoEnabled: false, userOff: false };
  }
  return entry;
}

function normalizeTemporality(v: unknown): OtlpTemporality {
  return v === 'delta' ? 'delta' : 'cumulative';
}

/** Repair one stored entry; unknown kinds are dropped. */
function normalizeEntry(raw: unknown): TelemetryDestinationEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind as TelemetryDestinationKind;
  if (!TELEMETRY_DESTINATION_KINDS.includes(kind)) return null;
  const entry: TelemetryDestinationEntry = {
    ...defaultEntry(kind),
    id: typeof r.id === 'string' && r.id ? r.id : kind,
    enabled: r.enabled === true,
    level: normalizeLevel(r.level),
    preset: TELEMETRY_FILTER_PRESETS.includes(r.preset as never) ? (r.preset as TelemetryDestinationEntry['preset']) : defaultEntry(kind).preset,
  };
  if (typeof r.confirmedHost === 'string') entry.confirmedHost = r.confirmedHost;
  if (kind === 'framebriar') {
    const f = (r.framebriar && typeof r.framebriar === 'object' ? r.framebriar : {}) as Record<string, unknown>;
    entry.framebriar = { autoEnabled: f.autoEnabled === true, userOff: f.userOff === true };
  }
  if (kind === 'otlp') {
    const o = (r.otlp && typeof r.otlp === 'object' ? r.otlp : {}) as Record<string, unknown>;
    entry.otlp = {
      endpoint: typeof o.endpoint === 'string' ? o.endpoint : '',
      headerNames: Array.isArray(o.headerNames) ? o.headerNames.filter((n): n is string => typeof n === 'string') : [],
      temporality: normalizeTemporality(o.temporality),
    };
  }
  return entry;
}

/**
 * Phase 2 → destinations list. Exactly one destination was active; it stays
 * the only enabled one, with the same level, so nothing changes in what is
 * sent or where.
 */
function fromPhase2(p: Phase2Fields): TelemetryDestinationEntry[] {
  const active: TelemetryDestinationKind = p.destination === 'otlp' ? 'otlp' : 'azure';
  const level = normalizeLevel(p.level);
  return TELEMETRY_DESTINATION_KINDS.map((kind) => {
    const entry = { ...defaultEntry(kind), level, enabled: p.enabled === true && kind === active };
    if (kind === 'otlp') {
      entry.otlp = {
        endpoint: typeof p.otlpEndpoint === 'string' ? p.otlpEndpoint : '',
        headerNames: Array.isArray(p.otlpHeaderNames) ? p.otlpHeaderNames.filter((n): n is string => typeof n === 'string') : [],
        temporality: normalizeTemporality(p.otlpTemporality),
      };
      if (typeof p.otlpConfirmedHost === 'string') entry.confirmedHost = p.otlpConfirmedHost;
    }
    return entry;
  });
}

/**
 * Convert any earlier file to the current shape: Phase 1 (destination object
 * with a plaintext secret) → Phase 2 (flat fields) → destinations list.
 */
export function migrateTelemetrySettings(raw: Record<string, unknown>): TelemetrySettings {
  const settings = { ...raw } as Record<string, unknown>;
  const legacy = settings.destination;
  if (legacy && typeof legacy === 'object') {
    // Phase 1: the destination object, possibly holding a plaintext secret.
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
  }

  // The settings store merges the defaults (which carry a `destinations`
  // list) over the file before migrating, so the Phase 2 keys, which the
  // current shape never has, are what mark an older file.
  const isPhase2 = PHASE2_KEYS.some((key) => key in settings);
  let entries: TelemetryDestinationEntry[];
  if (isPhase2 || !Array.isArray(settings.destinations)) {
    entries = fromPhase2(settings as Phase2Fields);
  } else {
    entries = settings.destinations.map(normalizeEntry).filter((e): e is TelemetryDestinationEntry => e !== null);
  }
  for (const key of PHASE2_KEYS) delete settings[key];
  // Every kind has an entry, in a stable order, so the UI can list them all.
  const byKind = new Map(entries.map((e) => [e.kind, e]));
  settings.destinations = TELEMETRY_DESTINATION_KINDS.map((kind) => byKind.get(kind) ?? defaultEntry(kind));

  if (typeof settings.consentVersion !== 'number') settings.consentVersion = 0;
  if (typeof settings.sampleRate !== 'number') settings.sampleRate = 1;
  return settings as unknown as TelemetrySettings;
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

/** A destination entry by id (or kind, which is the id today). */
export function findDestination(settings: TelemetrySettings, id: string): TelemetryDestinationEntry | undefined {
  return settings.destinations.find((d) => d.id === id);
}

/** Enabled entries, in display order. */
export function enabledDestinations(settings: TelemetrySettings): TelemetryDestinationEntry[] {
  return settings.destinations.filter((d) => d.enabled);
}

/** Replace one entry by id, keeping the others. */
export function withDestination(
  settings: TelemetrySettings,
  id: string,
  fn: (entry: TelemetryDestinationEntry) => TelemetryDestinationEntry,
): TelemetrySettings {
  return { ...settings, destinations: settings.destinations.map((d) => (d.id === id ? fn(d) : d)) };
}

/** One destination plus its secrets, ready for validation and the exporters. */
export function resolveDestination(entry: TelemetryDestinationEntry | undefined, settings: TelemetrySettings, secrets: TelemetrySecrets): DestinationConfig | null {
  if (!entry) return null;
  const merged: TelemetrySecrets = { ...legacySecrets(settings), ...secrets };
  if (entry.kind === 'azure') {
    return merged.connectionString ? { kind: 'azure', connectionString: merged.connectionString } : null;
  }
  if (entry.kind === 'otlp') {
    if (!entry.otlp?.endpoint) return null;
    const headers: Record<string, string> = {};
    for (const name of entry.otlp.headerNames) {
      const value = merged.otlpHeaders?.[name];
      if (typeof value === 'string') headers[name] = value;
    }
    return { kind: 'otlp', endpoint: entry.otlp.endpoint, headers };
  }
  return null;
}

/** Cheap, synchronous pre-check of one entry, used before `ready` (no decryption). */
export function isEntryConfigured(entry: TelemetryDestinationEntry, settings: TelemetrySettings): boolean {
  if (entry.kind === 'framebriar') return getFramebriarTelemetrySource()?.() != null;
  if (entry.kind === 'otlp') {
    return !!entry.otlp?.endpoint || (settings.legacyDestination?.kind === 'otlp');
  }
  if (settings.legacyDestination && settings.legacyDestination.kind !== 'otlp') return true;
  try {
    return fs.existsSync(getSecretPath());
  } catch {
    return false;
  }
}

/** Some enabled destination looks configured. */
export function hasDestinationConfigured(settings: TelemetrySettings): boolean {
  return enabledDestinations(settings).some((d) => isEntryConfigured(d, settings));
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
