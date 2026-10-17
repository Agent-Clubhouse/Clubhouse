/**
 * Settings actions behind window.clubhouse.telemetrySettings (spec §6.8).
 * Every action validates here, in main; the renderer is not trusted, and it
 * only ever receives a masked TelemetryStatus.
 */
import { app } from 'electron';
import {
  TELEMETRY_CONSENT_VERSION,
  type OtlpHeaderInput,
  type OtlpTemporality,
  type TelemetryAcknowledgements,
  type TelemetryActionResult,
  type TelemetryConfirmation,
  type TelemetryDestinationKind,
  type TelemetryEnableResult,
  type TelemetryPreviewItem,
  type TelemetryStatus,
  type TelemetryTestReport,
} from '../../shared/telemetry/settings-types';
import { TELEMETRY_LEVELS, type TelemetryLevel } from '../../shared/telemetry/attributes';
import {
  describeDestinationError,
  disableTelemetry,
  enableTelemetry,
  getLastStartError,
  isRunning,
  restartTelemetry,
  sendTestEvent,
} from './bootstrap';
import { getRuntime } from './facade';
import { createIdentity } from './ids';
import { countOfflineItems, deleteOfflineData, getOfflineDir } from './offline';
import { getSecureStorageState, readSecrets, updateSecrets, type TelemetrySecrets } from './secret-store';
import {
  getTelemetrySettings,
  HEADER_TOKEN_RE,
  isExperimentEnabled,
  legacySecrets,
  migrateLegacySecrets,
  parseConnectionString,
  RESERVED_HEADERS,
  resolveDestination,
  updateTelemetrySettings,
  validateDestination,
  type TelemetrySettings,
} from './settings';
import type { ExportRecord } from './types';

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

export async function getStatus(): Promise<TelemetryStatus> {
  const { settings, secrets } = await prepare();
  const azureDest = resolveDestination({ ...settings, destination: 'azure' }, secrets);
  const azureCs = azureDest?.kind === 'azure' ? azureDest.connectionString : undefined;
  const parts = azureCs ? parseConnectionString(azureCs) : {};
  let azureHost: string | undefined;
  try {
    azureHost = parts.ingestionendpoint ? new URL(parts.ingestionendpoint).host : undefined;
  } catch {
    azureHost = undefined;
  }
  let otlpHost: string | undefined;
  try {
    otlpHost = settings.otlpEndpoint ? new URL(settings.otlpEndpoint).host : undefined;
  } catch {
    otlpHost = undefined;
  }
  const headerValues: Record<string, string> = { ...(legacySecrets(settings).otlpHeaders ?? {}), ...(secrets.otlpHeaders ?? {}) };
  return {
    available: isExperimentEnabled(),
    // A Phase 1 file can be enabled without recorded consent; it isn't
    // exporting, so show it as off until the user turns it on (and consents).
    enabled: settings.enabled && settings.consentVersion >= TELEMETRY_CONSENT_VERSION,
    running: isRunning(),
    destination: settings.destination,
    level: settings.level,
    sampleRate: settings.sampleRate,
    otlpTemporality: settings.otlpTemporality,
    azure: {
      configured: !!azureCs,
      ikeyLast4: parts.instrumentationkey ? last4(parts.instrumentationkey) : undefined,
      host: azureHost,
    },
    otlp: {
      configured: !!settings.otlpEndpoint,
      endpoint: settings.otlpEndpoint,
      host: otlpHost,
      headers: settings.otlpHeaderNames.map((name) => ({ name, last4: last4(headerValues[name] ?? '') })),
      confirmedHost: settings.otlpConfirmedHost,
    },
    installId: settings.installId,
    consentAccepted: settings.consentVersion >= TELEMETRY_CONSENT_VERSION,
    secureStorage: getSecureStorageState(),
    weakStorageAccepted: settings.weakStorageAccepted === true,
    offlineItems: await countOfflineItems(getOfflineDir()),
    lastError: settings.enabled && settings.consentVersion >= TELEMETRY_CONSENT_VERSION ? getLastStartError() : undefined,
  };
}

async function fail(reason: string, message: string): Promise<TelemetryActionResult> {
  return { ok: false, reason, message, status: await getStatus() };
}

async function done(): Promise<TelemetryActionResult> {
  return { ok: true, status: await getStatus() };
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
  await updateSecrets((s) => ({ ...s, connectionString: connectionString.trim() }));
  if (storage === 'weak_ok') await updateTelemetrySettings((s) => ({ ...s, weakStorageAccepted: true }));
  // A new resource: nothing queued for the old one may be sent to it.
  if (isRunning() && settings.destination === 'azure') await restartTelemetry({ clearOffline: true });
  return done();
}

/**
 * Clearing must also remove a not-yet-migrated Phase 1 plaintext secret
 * (it stays in the file when secure storage is unavailable).
 */
async function dropLegacyDestination(kind: TelemetryDestinationKind): Promise<void> {
  const legacy = getTelemetrySettings().legacyDestination;
  if (!legacy || (legacy.kind === 'otlp' ? 'otlp' : 'azure') !== kind) return;
  await updateTelemetrySettings((s) => {
    const next = { ...s };
    delete next.legacyDestination;
    return next;
  });
}

export async function clearAzureConnectionString(): Promise<TelemetryActionResult> {
  const { settings } = await prepare();
  if (settings.enabled && settings.destination === 'azure') {
    await updateTelemetrySettings((s) => ({ ...s, enabled: false }));
    await disableTelemetry();
  }
  await updateSecrets((s) => ({ ...s, connectionString: undefined }));
  await dropLegacyDestination('azure');
  return done();
}

export interface OtlpConfigInput {
  endpoint: string;
  headers: OtlpHeaderInput[];
}

export async function saveOtlpConfig(input: OtlpConfigInput, ack?: TelemetryAcknowledgements): Promise<TelemetryEnableResult> {
  const { settings, secrets } = await prepare();
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
  const hostChanged = validation.host !== settings.otlpConfirmedHost;
  const activeOtlp = settings.enabled && settings.destination === 'otlp';
  if (activeOtlp && hostChanged && ack?.host !== validation.host) {
    return { ok: false, reason: 'needs_confirmation', needs: ['destination'], host: validation.host, status: await getStatus() };
  }

  await updateSecrets((s) => ({ ...s, otlpHeaders: Object.keys(values).length ? values : undefined }));
  await updateTelemetrySettings((s) => ({
    ...s,
    otlpEndpoint: endpoint,
    otlpHeaderNames: names,
    otlpConfirmedHost: ack?.host === validation.host ? validation.host : s.otlpConfirmedHost,
  }));
  if (activeOtlp && isRunning()) await restartTelemetry({ clearOffline: hostChanged });
  return done();
}

export async function clearOtlpConfig(): Promise<TelemetryActionResult> {
  const { settings } = await prepare();
  if (settings.enabled && settings.destination === 'otlp') {
    await updateTelemetrySettings((s) => ({ ...s, enabled: false }));
    await disableTelemetry();
  }
  await updateSecrets((s) => ({ ...s, otlpHeaders: undefined }));
  await updateTelemetrySettings((s) => ({ ...s, otlpEndpoint: '', otlpHeaderNames: [], otlpConfirmedHost: undefined }));
  await dropLegacyDestination('otlp');
  return done();
}

/**
 * Turn a destination on or off. Turning on asks (via `needs`) for consent the
 * first time, for the OTLP host on first use or after it changed, for a
 * switch away from the other destination, and for weak secret storage. The
 * renderer repeats the call with `ack` once the user confirms.
 */
export async function setEnabled(
  destination: TelemetryDestinationKind,
  enabled: boolean,
  ack: TelemetryAcknowledgements = {},
): Promise<TelemetryEnableResult> {
  const { settings, secrets } = await prepare();
  if (!enabled) {
    if (settings.enabled && settings.destination === destination) {
      await updateTelemetrySettings((s) => ({ ...s, enabled: false }));
      await disableTelemetry();
    }
    return done();
  }
  if (!isExperimentEnabled()) return fail('not_available', 'Telemetry export is an experimental feature. Turn it on in Experimental settings first.');

  const dest = resolveDestination({ ...settings, destination }, secrets);
  const validation = validateDestination(dest);
  if (!dest || !('host' in validation)) {
    return fail('not_configured', destination === 'azure' ? 'Save a connection string first.' : 'Save an OTLP endpoint first.');
  }

  const needs: TelemetryConfirmation[] = [];
  if (settings.consentVersion < TELEMETRY_CONSENT_VERSION && !ack.consent) needs.push('consent');
  const switching = settings.enabled && settings.destination !== destination;
  const hostConfirmed = ack.host === validation.host;
  if (switching && !hostConfirmed) needs.push('switch_destination');
  if (destination === 'otlp' && settings.otlpConfirmedHost !== validation.host && !hostConfirmed && !switching) {
    needs.push('destination');
  }
  const usesSecrets = destination === 'azure' || Object.keys(dest.kind === 'otlp' ? dest.headers ?? {} : {}).length > 0;
  if (usesSecrets && getSecureStorageState() === 'weak' && !settings.weakStorageAccepted && !ack.weakStorage) {
    needs.push('weak_storage');
  }
  if (needs.length) {
    return { ok: false, reason: 'needs_confirmation', needs, host: validation.host, status: await getStatus() };
  }

  await updateTelemetrySettings((s) => ({
    ...s,
    enabled: true,
    destination,
    consentVersion: Math.max(s.consentVersion, TELEMETRY_CONSENT_VERSION),
    otlpConfirmedHost: destination === 'otlp' ? validation.host : s.otlpConfirmedHost,
    weakStorageAccepted: s.weakStorageAccepted || ack.weakStorage === true,
  }));
  const ok = switching || isRunning() ? await restartTelemetry({ clearOffline: switching }) : await enableTelemetry();
  if (!ok) return fail('start_failed', getLastStartError() ?? 'Telemetry failed to start.');
  return done();
}

export async function setLevel(level: TelemetryLevel): Promise<TelemetryActionResult> {
  if (!TELEMETRY_LEVELS.includes(level)) return fail('invalid_level', 'Unknown telemetry level.');
  await prepare();
  await updateTelemetrySettings((s) => ({ ...s, level }));
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
  await updateTelemetrySettings((s) => ({
    ...s,
    ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
    ...(input.otlpTemporality !== undefined ? { otlpTemporality: input.otlpTemporality } : {}),
  }));
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

/** Turns telemetry off and removes the install id, salt and offline queue. */
export async function deleteLocalData(): Promise<TelemetryActionResult> {
  await prepare();
  await updateTelemetrySettings((s) => ({ ...s, enabled: false }));
  await disableTelemetry({ deleteLocalData: true });
  return done();
}

export function describeTestFailure(record: ExportRecord, destination: TelemetryDestinationKind): string {
  const s = record.httpStatus;
  const code = record.errorCode ?? '';
  if (s === 400 && destination === 'azure') return 'Rejected (HTTP 400). Check the instrumentation key in the connection string.';
  if ((s === 401 || s === 403) && destination === 'azure') {
    return `Rejected (HTTP ${s}). Local authentication is probably disabled on this resource; Entra ID sign-in is not supported yet.`;
  }
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

export async function sendTest(): Promise<TelemetryTestReport> {
  const { settings } = await prepare();
  if (!isRunning()) return { ok: false, message: 'Turn telemetry on to send a test event.' };
  const result = await sendTestEvent();
  const failed = result.exports?.find((r) => !r.ok);
  if (failed) {
    return { ok: false, latencyMs: result.latencyMs, httpStatus: failed.httpStatus, message: describeTestFailure(failed, settings.destination) };
  }
  if (!result.exports?.length) return { ok: false, latencyMs: result.latencyMs, message: 'No response from the destination within 10 seconds.' };
  return { ok: true, latencyMs: result.latencyMs, message: 'Accepted' };
}

export function getPreview(): TelemetryPreviewItem[] {
  return getRuntime()?.preview() ?? [];
}
