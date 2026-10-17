/**
 * Settings actions behind window.clubhouse.telemetrySettings (spec §6.8,
 * §6.11). Every action validates here, in main; the renderer is not trusted,
 * and it only ever receives a masked TelemetryStatus.
 *
 * Several destinations can be enabled at once, each with its own switch,
 * level and preset. Consent names every host that will receive data.
 */
import { app } from 'electron';
import {
  TELEMETRY_CONSENT_VERSION,
  TELEMETRY_FILTER_PRESETS,
  type OtlpHeaderInput,
  type OtlpTemporality,
  type TelemetryAcknowledgements,
  type TelemetryActionResult,
  type TelemetryConfirmation,
  type TelemetryDestinationEntry,
  type TelemetryDestinationHealth,
  type TelemetryDestinationStatus,
  type TelemetryEnableResult,
  type TelemetryFilterPreset,
  type TelemetryPreviewItem,
  type TelemetryStatus,
  type TelemetryTestReport,
} from '../../shared/telemetry/settings-types';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import {
  describeDestinationError,
  disableTelemetry,
  enableTelemetry,
  getActiveDestinations,
  getDestinationStartError,
  getLastStartError,
  isRunning,
  restartTelemetry,
  sendTestEvent,
} from './bootstrap';
import { getAdapter, resolveEntry } from './destinations/registry';
import { getRuntime } from './facade';
import { createIdentity } from './ids';
import { countOfflineItems, deleteOfflineData, getOfflineDir } from './offline';
import { getSecureStorageState, readSecrets, updateSecrets, type TelemetrySecrets } from './secret-store';
import {
  enabledDestinations,
  findDestination,
  getTelemetrySettings,
  HEADER_TOKEN_RE,
  isExperimentEnabled,
  legacySecrets,
  migrateLegacySecrets,
  parseConnectionString,
  RESERVED_HEADERS,
  updateTelemetrySettings,
  validateDestination,
  withDestination,
  type TelemetrySettings,
} from './settings';
import type { ExportRecord } from './types';
import { getBoundFramebriarSession, getFramebriarTelemetrySource, onFramebriarConnectionChanged } from './destinations/framebriar-source';
import { appLog } from '../services/log-service';

const last4 = (value: string): string => value.slice(-4);

/** The repo's tsconfig isn't strict, so `!v.ok` doesn't narrow the union. */
function invalidReason(v: ReturnType<typeof validateDestination>): string | undefined {
  return 'reason' in v ? v.reason : undefined;
}

async function prepare(): Promise<{ settings: TelemetrySettings; secrets: TelemetrySecrets }> {
  await app.whenReady();
  await migrateLegacySecrets().catch(() => false);
  return { settings: getTelemetrySettings(), secrets: await readSecrets() };
}

function hostOf(entry: TelemetryDestinationEntry, settings: TelemetrySettings, secrets: TelemetrySecrets): string | undefined {
  const { validation } = resolveEntry(entry, settings, secrets);
  return 'host' in validation ? validation.host : undefined;
}

export function describeTestFailure(record: ExportRecord, kind: TelemetryDestinationEntry['kind']): string {
  const specific = getAdapter(kind).describeFailure?.(record);
  if (specific) return specific;
  const s = record.httpStatus;
  const code = record.errorCode ?? '';
  if (s === 401 || s === 403) return `Rejected (HTTP ${s}). Check the headers.`;
  if (s === 404) return 'Not found (HTTP 404). Check the base path: Clubhouse appends /v1/traces, /v1/metrics and /v1/logs.';
  if (s === 415) return 'Rejected (HTTP 415). This backend does not accept OTLP over HTTP/JSON.';
  if (s !== undefined) return `Rejected (HTTP ${s}).`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Could not resolve the host. Check the address and any proxy settings.';
  if (code === 'ECONNREFUSED') return 'Connection refused. Is the collector running?';
  if (/CERT|SSL|TLS/i.test(code) || /certificate|tls/i.test(record.errorMessage ?? '')) {
    return 'The TLS connection failed. Check the endpoint certificate.';
  }
  return record.errorMessage ? `Export failed: ${record.errorMessage}` : 'Export failed.';
}

function healthOf(entry: TelemetryDestinationEntry, consented: boolean): TelemetryDestinationHealth {
  if (!entry.enabled || !consented) return { state: 'off' };
  const active = getActiveDestinations().some((d) => d.id === entry.id);
  if (!active) {
    const message = getDestinationStartError(entry.id) ?? (isRunning() ? undefined : getLastStartError());
    return message ? { state: 'error', message } : { state: 'pending' };
  }
  const h = getRuntime()?.destinationHealth()[entry.id];
  if (!h) return { state: 'pending' };
  if (h.lastFailure) {
    return { state: 'failing', lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt, message: describeTestFailure(h.lastFailure, entry.kind) };
  }
  return { state: h.lastSuccessAt ? 'ok' : 'pending', lastSuccessAt: h.lastSuccessAt, lastFailureAt: h.lastFailureAt };
}

export async function getStatus(): Promise<TelemetryStatus> {
  const { settings, secrets } = await prepare();
  const consented = settings.consentVersion >= TELEMETRY_CONSENT_VERSION;
  const azureEntry = findDestination(settings, 'azure');
  const otlpEntry = findDestination(settings, 'otlp');
  const merged: TelemetrySecrets = { ...legacySecrets(settings), ...secrets };
  const azureCs = merged.connectionString;
  const parts = azureCs ? parseConnectionString(azureCs) : {};
  let azureHost: string | undefined;
  try {
    azureHost = parts.ingestionendpoint ? new URL(parts.ingestionendpoint).host : undefined;
  } catch {
    azureHost = undefined;
  }
  const otlp = otlpEntry?.otlp ?? { endpoint: '', headerNames: [], temporality: 'cumulative' as OtlpTemporality };
  let otlpHost: string | undefined;
  try {
    otlpHost = otlp.endpoint ? new URL(otlp.endpoint).host : undefined;
  } catch {
    otlpHost = undefined;
  }
  const headerValues: Record<string, string> = merged.otlpHeaders ?? {};
  const active = new Set(getActiveDestinations().map((d) => d.id));
  const destinations: TelemetryDestinationStatus[] = settings.destinations.map((entry) => {
    const { config } = resolveEntry(entry, settings, secrets);
    return {
      id: entry.id,
      kind: entry.kind,
      label: getAdapter(entry.kind).label,
      enabled: entry.enabled && consented,
      level: entry.level,
      preset: entry.preset,
      configured: config !== null,
      host: hostOf(entry, settings, secrets),
      active: active.has(entry.id),
      health: healthOf(entry, consented),
      offlineQueue: getAdapter(entry.kind).usesOfflineQueue === true,
      ...(entry.kind === 'framebriar' ? { userOff: entry.framebriar?.userOff === true } : {}),
    };
  });
  const anyEnabled = destinations.some((d) => d.enabled);
  return {
    available: isExperimentEnabled(),
    // A Phase 1 file can be enabled without recorded consent; it isn't
    // exporting, so show it as off until the user turns it on (and consents).
    enabled: anyEnabled,
    running: isRunning(),
    destinations,
    sampleRate: settings.sampleRate,
    azure: {
      configured: !!azureCs,
      ikeyLast4: parts.instrumentationkey ? last4(parts.instrumentationkey) : undefined,
      host: azureHost,
    },
    otlp: {
      configured: !!otlp.endpoint,
      endpoint: otlp.endpoint,
      host: otlpHost,
      headers: otlp.headerNames.map((name) => ({ name, last4: last4(headerValues[name] ?? '') })),
      confirmedHost: otlpEntry?.confirmedHost,
      temporality: otlp.temporality,
    },
    installId: settings.installId,
    consentAccepted: consented,
    secureStorage: getSecureStorageState(),
    weakStorageAccepted: settings.weakStorageAccepted === true,
    offlineItems: azureEntry ? await countOfflineItems(getOfflineDir()) : 0,
    lastError: anyEnabled && !isRunning() ? getLastStartError() : undefined,
  };
}

async function fail(reason: string, message: string): Promise<TelemetryActionResult> {
  return { ok: false, reason, message, status: await getStatus() };
}

async function done(): Promise<TelemetryActionResult> {
  return { ok: true, status: await getStatus() };
}

/**
 * Bring the running exporter in line with the settings: stop when nothing is
 * enabled, start when something newly is, restart otherwise. `clearOffline`
 * drops Azure's queue (its resource changed or it was turned off), so nothing
 * queued for one resource is ever sent to another (spec §6.8).
 */
async function applyRuntime({ clearOffline = false } = {}): Promise<boolean> {
  const settings = getTelemetrySettings();
  if (enabledDestinations(settings).length === 0 || settings.consentVersion < TELEMETRY_CONSENT_VERSION) {
    if (isRunning()) await disableTelemetry();
    else if (clearOffline) await deleteOfflineData().catch(() => {});
    return true;
  }
  if (isRunning()) return restartTelemetry({ clearOffline });
  if (clearOffline) await deleteOfflineData().catch(() => {});
  return enableTelemetry();
}

/** Secure storage gate shared by both secret-saving actions. */
async function checkStorage(ack: TelemetryAcknowledgements | undefined, settings: TelemetrySettings): Promise<TelemetryEnableResult | 'weak_ok' | 'ok'> {
  const state = getSecureStorageState();
  if (state === 'unavailable') {
    return fail('secure_storage_unavailable', 'Secure storage is not available on this system, so secrets cannot be saved.');
  }
  if (state === 'weak' && !settings.weakStorageAccepted) {
    if (!ack?.weakStorage) {
      return { ok: false, reason: 'needs_confirmation', needs: ['weak_storage'], status: await getStatus() };
    }
    return 'weak_ok';
  }
  return 'ok';
}

const BARE_IKEY_RE = /^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;

export async function saveAzureConnectionString(
  connectionString: string,
  ack?: TelemetryAcknowledgements,
): Promise<TelemetryEnableResult> {
  const { settings } = await prepare();
  if (BARE_IKEY_RE.test(connectionString)) {
    return fail('bare_instrumentation_key', 'Paste the full connection string. Ingestion with only an instrumentation key was retired in 2025.');
  }
  const reason = invalidReason(validateDestination({ kind: 'azure', connectionString: connectionString.trim() }));
  if (reason) {
    const extra = reason === 'not_azure_ingestion_host' ? ' Use Other destinations (OTLP) for any other backend.' : '';
    return fail(reason, describeDestinationError(reason) + extra);
  }
  const storage = await checkStorage(ack, settings);
  if (typeof storage === 'object') return storage;
  // A different ingestion host on an enabled destination is a new recipient:
  // confirm it before anything is sent there.
  const validation = validateDestination({ kind: 'azure', connectionString: connectionString.trim() });
  const host = 'host' in validation ? validation.host : undefined;
  const azure = findDestination(settings, 'azure');
  const azureActive = azure?.enabled === true && settings.consentVersion >= TELEMETRY_CONSENT_VERSION;
  if (azureActive && host && host !== azure?.confirmedHost && ack?.host !== host) {
    return { ok: false, reason: 'needs_confirmation', needs: ['destination'], host, hosts: [host], status: await getStatus() };
  }
  await updateSecrets((s) => ({ ...s, connectionString: connectionString.trim() }));
  if (storage === 'weak_ok') await updateTelemetrySettings((s) => ({ ...s, weakStorageAccepted: true }));
  if (azureActive && host) await updateTelemetrySettings((s) => withDestination(s, 'azure', (d) => ({ ...d, confirmedHost: host })));
  // A new resource: nothing queued for the old one may be sent to it.
  if (isRunning() && azure?.enabled) await restartTelemetry({ clearOffline: true });
  return done();
}

/**
 * Clearing must also remove a not-yet-migrated Phase 1 plaintext secret
 * (it stays in the file when secure storage is unavailable).
 */
async function dropLegacyDestination(kind: TelemetryDestinationEntry['kind']): Promise<void> {
  const legacy = getTelemetrySettings().legacyDestination;
  if (!legacy || (legacy.kind === 'otlp' ? 'otlp' : 'azure') !== kind) return;
  await updateTelemetrySettings((s) => {
    const next = { ...s };
    delete next.legacyDestination;
    return next;
  });
}

export async function clearAzureConnectionString(): Promise<TelemetryActionResult> {
  await prepare();
  await updateTelemetrySettings((s) => withFramebriarFollowing(withDestination(s, 'azure', (d) => ({ ...d, enabled: false, confirmedHost: undefined }))));
  await updateSecrets((s) => ({ ...s, connectionString: undefined }));
  await dropLegacyDestination('azure');
  await applyRuntime({ clearOffline: true });
  return done();
}

export interface OtlpConfigInput {
  endpoint: string;
  headers: OtlpHeaderInput[];
}

export async function saveOtlpConfig(input: OtlpConfigInput, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> {
  const { settings, secrets } = await prepare();
  const entry = findDestination(settings, 'otlp');
  const names = input.headers.map((h) => h.name.trim());
  if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) {
    return fail('duplicate_header_name', 'Each header name can be used only once.');
  }
  for (const name of names) {
    if (!HEADER_TOKEN_RE.test(name)) return fail('invalid_header_name', `"${name}" is not a valid header name.`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) return fail('reserved_header_name', `"${name}" is set by Clubhouse and can't be overridden.`);
  }
  const values: Record<string, string> = {};
  input.headers.forEach((h, i) => {
    const value = h.value ?? secrets.otlpHeaders?.[names[i]];
    if (typeof value === 'string') values[names[i]] = value;
  });
  const missing = names.find((n) => values[n] === undefined);
  if (missing) return fail('missing_header_value', `Enter a value for the "${missing}" header.`);

  const endpoint = input.endpoint.trim();
  const validation = validateDestination({ kind: 'otlp', endpoint, headers: values });
  const reason = invalidReason(validation);
  if (reason || !('host' in validation)) return fail(reason ?? 'invalid_url', describeDestinationError(reason ?? 'invalid_url'));

  if (Object.keys(values).length > 0) {
    const storage = await checkStorage(ack, settings);
    if (typeof storage === 'object') return storage;
    if (storage === 'weak_ok') await updateTelemetrySettings((s) => ({ ...s, weakStorageAccepted: true }));
  }

  // Changing the host of a running OTLP export needs a fresh confirmation.
  const hostChanged = validation.host !== entry?.confirmedHost;
  const activeOtlp = entry?.enabled === true && settings.consentVersion >= TELEMETRY_CONSENT_VERSION;
  if (activeOtlp && hostChanged && ack?.host !== validation.host) {
    return { ok: false, reason: 'needs_confirmation', needs: ['destination'], host: validation.host, hosts: [validation.host], status: await getStatus() };
  }

  await updateSecrets((s) => ({ ...s, otlpHeaders: Object.keys(values).length ? values : undefined }));
  await updateTelemetrySettings((s) => withDestination(s, 'otlp', (d) => ({
    ...d,
    otlp: { endpoint, headerNames: names, temporality: d.otlp?.temporality ?? 'cumulative' },
    confirmedHost: ack?.host === validation.host ? validation.host : d.confirmedHost,
  })));
  if (activeOtlp && isRunning()) await restartTelemetry();
  return done();
}

export async function clearOtlpConfig(): Promise<TelemetryActionResult> {
  await prepare();
  await updateSecrets((s) => ({ ...s, otlpHeaders: undefined }));
  await updateTelemetrySettings((s) => withFramebriarFollowing(withDestination(s, 'otlp', (d) => ({
    ...d,
    enabled: false,
    otlp: { endpoint: '', headerNames: [], temporality: d.otlp?.temporality ?? 'cumulative' },
    confirmedHost: undefined,
  }))));
  await dropLegacyDestination('otlp');
  await applyRuntime();
  return done();
}

/**
 * Turn one destination on or off; the others keep running. Turning one on
 * asks (via `needs`) for consent the first time, naming every host that will
 * then receive data; for a user-entered host on first use or after it
 * changed; and for weak secret storage. The renderer repeats the call with
 * `ack` once the user confirms.
 */
export async function setEnabled(
  destinationId: string,
  enabled: boolean,
  ack: TelemetryAcknowledgements = {},
): Promise<TelemetryEnableResult> {
  const { settings, secrets } = await prepare();
  const entry = findDestination(settings, destinationId);
  if (!entry) return fail('unknown_destination', 'Unknown destination.');
  if (!enabled) {
    const clearOffline = getAdapter(entry.kind).usesOfflineQueue === true;
    const before = enabledIds(settings);
    const next = await updateTelemetrySettings((s) => withFramebriarFollowing(withDestination(s, destinationId, (d) => ({
      ...d,
      enabled: false,
      // An explicit Off sticks: the Feedback link never turns it back on.
      ...(d.kind === 'framebriar' ? { framebriar: { userOff: true } } : {}),
    }))));
    // Nothing changed (e.g. "Not now" while it was already off): no restart.
    if (clearOffline || enabledIds(next) !== before) await applyRuntime({ clearOffline });
    return done();
  }
  if (!isExperimentEnabled()) return fail('not_available', 'Telemetry export is an experimental feature. Turn it on in Experimental settings first.');

  const { config, validation } = resolveEntry(entry, settings, secrets);
  if (!config || !('host' in validation)) {
    return fail('not_configured', NOT_CONFIGURED[entry.kind]);
  }

  // Framebriar never exports on its own: it follows another destination.
  if (entry.kind === 'framebriar' && !exportIsOn(settings)) {
    return fail('needs_other_destination', 'Turn on another telemetry destination first: the developer gets telemetry only while your own export is on.');
  }

  const consented = settings.consentVersion >= TELEMETRY_CONSENT_VERSION;
  // Framebriar will follow this destination on while Feedback is connected; if its
  // host isn't confirmed yet, this dialog names it and confirms it too.
  const followHost = entry.kind !== 'framebriar' ? framebriarFollowHost(settings) : undefined;
  const followNeedsConfirm = !!followHost && findDestination(settings, 'framebriar')?.confirmedHost !== followHost;
  const followConfirmed = followNeedsConfirm && ack.followHost === followHost;
  // Everything that will be sending once this is confirmed: other enabled
  // destinations start too if consent is only being given now.
  const hosts = [
    ...enabledDestinations(settings).filter((d) => d.id !== destinationId).map((d) => hostOf(d, settings, secrets)),
    validation.host,
    // Framebriar comes on with export while Feedback is connected: name it too.
    ...(followHost ? [followHost] : []),
  ].filter((h): h is string => !!h);

  const needs: TelemetryConfirmation[] = [];
  if (!consented && !ack.consent) needs.push('consent');
  const hostConfirmed = ack.host === validation.host;
  // Every kind's host is confirmed before it receives anything: on first use,
  // after it changed, and always when another destination is already on, so
  // adding a second destination never starts sending without a dialog.
  const othersEnabled = enabledDestinations(settings).some((d) => d.id !== destinationId);
  // Framebriar always has another destination on; only its own host needs confirming.
  const confirmEvenIfKnown = othersEnabled && entry.kind !== 'framebriar';
  if (!hostConfirmed && (entry.confirmedHost !== validation.host || confirmEvenIfKnown)) needs.push('destination');
  // The dialog must have named Framebriar's host too, or it isn't confirmed (it may
  // have connected while the dialog was open).
  else if (followNeedsConfirm && !followConfirmed) needs.push('destination');
  const usesSecrets = entry.kind === 'azure' || Object.keys((config as { headers?: Record<string, string> }).headers ?? {}).length > 0;
  if (usesSecrets && getSecureStorageState() === 'weak' && !settings.weakStorageAccepted && !ack.weakStorage) {
    needs.push('weak_storage');
  }
  if (needs.length) {
    return {
      ok: false, reason: 'needs_confirmation', needs, host: validation.host, hosts: [...new Set(hosts)],
      ...(followNeedsConfirm ? { followHost } : {}),
      status: await getStatus(),
    };
  }

  await updateTelemetrySettings((s) => withFramebriarFollowing({
    ...withDestination(
      // The dialog named Framebriar's host as well: that confirms it.
      followConfirmed ? withDestination(s, 'framebriar', (d) => ({ ...d, confirmedHost: followHost })) : s,
      destinationId,
      (d) => ({
        ...d,
        // Framebriar's switch is derived (withFramebriarFollowing): On confirms
        // its host and lets it follow Feedback; it is never a sticky On.
        enabled: d.kind !== 'framebriar',
        confirmedHost: validation.host,
        ...(d.kind === 'framebriar' ? { framebriar: { userOff: false } } : {}),
      }),
    ),
    // Phase 1 files can hold an enabled entry from before consent was asked;
    // consenting now covers every host listed, so keep those as they are.
    consentVersion: Math.max(s.consentVersion, TELEMETRY_CONSENT_VERSION),
    weakStorageAccepted: s.weakStorageAccepted || ack.weakStorage === true,
  }));
  const ok = await applyRuntime();
  if (!ok || !getActiveDestinations().some((d) => d.id === destinationId)) {
    return fail('start_failed', getDestinationStartError(destinationId) ?? getLastStartError() ?? 'Telemetry failed to start.');
  }
  return done();
}

const NOT_CONFIGURED: Record<TelemetryDestinationEntry['kind'], string> = {
  azure: 'Save a connection string first.',
  otlp: 'Save an OTLP endpoint first.',
  framebriar: 'Connect Feedback in Settings, Feedback first.',
};

// --- Framebriar follows Feedback (spec §6.11) ------------------------------------

/** Export is on: the experiment, consent, and some other destination enabled. */
function exportIsOn(settings: TelemetrySettings): boolean {
  return isExperimentEnabled()
    && settings.consentVersion >= TELEMETRY_CONSENT_VERSION
    && enabledDestinations(settings).some((d) => d.kind !== 'framebriar');
}

function currentFramebriarHost(): string | undefined {
  return getFramebriarTelemetrySource()?.()?.host;
}

/** Framebriar's host when it would follow export on (Feedback connected, not switched off by the user). */
function framebriarFollowHost(settings: TelemetrySettings): string | undefined {
  const entry = findDestination(settings, 'framebriar');
  if (!entry || entry.enabled || entry.framebriar?.userOff) return undefined;
  return currentFramebriarHost();
}

/**
 * Whether Framebriar should be exporting (spec §6.11): only while Feedback is
 * connected, another destination is exporting, its current host is the one the
 * user confirmed, and the user hasn't switched it off.
 */
function framebriarWanted(settings: TelemetrySettings): boolean {
  const entry = findDestination(settings, 'framebriar');
  const host = currentFramebriarHost();
  return !!entry && host !== undefined && exportIsOn(settings) && !entry.framebriar?.userOff && entry.confirmedHost === host;
}

/** The settings with Framebriar's switch matching framebriarWanted. Every path that changes another destination goes through this. */
function withFramebriarFollowing(settings: TelemetrySettings): TelemetrySettings {
  const entry = findDestination(settings, 'framebriar');
  if (!entry) return settings;
  const want = framebriarWanted(settings);
  return entry.enabled === want ? settings : withDestination(settings, 'framebriar', (d) => ({ ...d, enabled: want }));
}

function enabledIds(settings: TelemetrySettings): string {
  return enabledDestinations(settings).map((d) => d.id).join(',');
}

let syncing: Promise<void> = Promise.resolve();

/**
 * Re-check Framebriar when Feedback's connection changes: turn it on or off to
 * match framebriarWanted, and restart the exporter when it should run but isn't
 * (Feedback connected after telemetry started) or is bound to a Feedback session
 * that has ended (Feedback restarted). Whenever Feedback isn't
 * connected the destination leaves the runtime, whatever its flags say.
 */
export function syncFramebriarDestination(): Promise<void> {
  syncing = syncing.then(async () => {
    const settings = getTelemetrySettings();
    const entry = findDestination(settings, 'framebriar');
    if (!entry) return;
    if (withFramebriarFollowing(settings) !== settings) {
      await updateTelemetrySettings(withFramebriarFollowing);
      await applyRuntime();
      return;
    }
    const active = getActiveDestinations().some((d) => d.id === 'framebriar');
    const current = getFramebriarTelemetrySource()?.();
    if (entry.enabled && current && (!active || getBoundFramebriarSession() !== current.sessionId)) await applyRuntime();
    else if (!entry.enabled && active) await applyRuntime();
  }).catch((err) => {
    // telemetry-exempt: logged; the next Feedback change retries.
    appLog('telemetry:control', 'warn', 'Could not update the Framebriar destination', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
  return syncing;
}

onFramebriarConnectionChanged(() => { void syncFramebriarDestination(); });

/** A destination's level and preset. */
export async function setFilter(destinationId: string, level: TelemetryLevel, preset: TelemetryFilterPreset): Promise<TelemetryActionResult> {
  if (!TELEMETRY_LEVELS.includes(level)) return fail('invalid_level', 'Unknown telemetry level.');
  if (!TELEMETRY_FILTER_PRESETS.includes(preset)) return fail('invalid_preset', 'Unknown filter preset.');
  const { settings } = await prepare();
  if (!findDestination(settings, destinationId)) return fail('unknown_destination', 'Unknown destination.');
  await updateTelemetrySettings((s) => withDestination(s, destinationId, (d) => ({ ...d, level, preset })));
  if (isRunning()) await restartTelemetry();
  return done();
}

export interface AdvancedInput {
  sampleRate?: number;
  otlpTemporality?: OtlpTemporality;
}

export async function setAdvanced(input: AdvancedInput): Promise<TelemetryActionResult> {
  await prepare();
  if (input.sampleRate !== undefined && !(input.sampleRate > 0 && input.sampleRate <= 1)) {
    return fail('invalid_sample_rate', 'The sample rate must be greater than 0 and at most 1.');
  }
  if (input.otlpTemporality !== undefined && input.otlpTemporality !== 'cumulative' && input.otlpTemporality !== 'delta') {
    return fail('invalid_temporality', 'Unknown metric temporality.');
  }
  await updateTelemetrySettings((s) => {
    let next = { ...s, ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}) };
    const temporality = input.otlpTemporality;
    if (temporality !== undefined) {
      next = withDestination(next, 'otlp', (d) => ({
        ...d,
        otlp: { endpoint: d.otlp?.endpoint ?? '', headerNames: d.otlp?.headerNames ?? [], temporality },
      }));
    }
    return next;
  });
  if (isRunning()) await restartTelemetry();
  return done();
}

/** Rotates the install id and hash salt together (spec §5.2). */
export async function resetInstallId(): Promise<TelemetryActionResult> {
  await prepare();
  await updateTelemetrySettings((s) => ({ ...s, ...createIdentity() }));
  if (isRunning()) await restartTelemetry({ clearOffline: true });
  return done();
}

export async function clearOfflineQueue(): Promise<TelemetryActionResult> {
  await deleteOfflineData().catch(() => {});
  return done();
}

/** Turns every destination off and removes the install id, salt and offline queue. */
export async function deleteLocalData(): Promise<TelemetryActionResult> {
  await prepare();
  await updateTelemetrySettings((s) => ({ ...s, destinations: s.destinations.map((d) => ({ ...d, enabled: false })) }));
  await disableTelemetry({ deleteLocalData: true });
  return done();
}

/** Send a test span and event to one destination only, and report its results. */
export async function sendTest(destinationId: string): Promise<TelemetryTestReport> {
  const { settings } = await prepare();
  const entry = findDestination(settings, destinationId);
  if (!entry) return { ok: false, message: 'Unknown destination.' };
  if (!isRunning() || !getActiveDestinations().some((d) => d.id === destinationId)) {
    return { ok: false, message: 'Turn this destination on to send a test event.' };
  }
  const result = await sendTestEvent(destinationId);
  const failed = result.exports?.find((r) => !r.ok);
  if (failed) {
    return { ok: false, latencyMs: result.latencyMs, httpStatus: failed.httpStatus, message: describeTestFailure(failed, entry.kind) };
  }
  if (!result.exports?.length) return { ok: false, latencyMs: result.latencyMs, message: 'No response from the destination within 10 seconds.' };
  return { ok: true, latencyMs: result.latencyMs, message: 'Accepted' };
}

export function getPreview(): TelemetryPreviewItem[] {
  return getRuntime()?.preview() ?? [];
}
