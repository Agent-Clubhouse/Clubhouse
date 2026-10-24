/**
 * Telemetry lifecycle (spec §6.7): startup, runtime enable/disable, test
 * event and offline-queue maintenance. Everything is gated behind the
 * `experimental.telemetry` flag plus `enabled` in telemetry-settings.json.
 *
 * `initTelemetry()` runs synchronously near the top of main/index.ts. When
 * telemetry is off it reads two small settings files and returns; the SDK
 * chunk is never imported. When on, it starts buffering facade calls and
 * loads the SDK asynchronously so it never blocks `ready`.
 */
import * as os from 'os';
import { telemetryInstanceId as instanceId } from './instance';
import { app } from 'electron';
import { appLog } from '../services/log-service';
import { ATTR } from '../../shared/telemetry/attributes';
import { TELEMETRY_CONSENT_VERSION } from '../../shared/telemetry/settings-types';
import {
  abortPending,
  beginPending,
  DEFAULT_FLUSH_TIMEOUT_MS,
  getRuntime,
  isExportActive,
  isTelemetryActive,
  setRuntime,
  tel,
} from './facade';
import { restartLocalRecording, syncLocalRecording } from './local-control';
import { createIdentity, isValidIdentity, type TelemetryIdentity } from './ids';
import { deleteOfflineData, getOfflineDir, OFFLINE_PRUNE_INTERVAL_MS, pruneOfflineDir } from './offline';
import { buildResourceAttributes, type ResourceInputs } from './resource';
import { NEW_CHROME_FLAG } from '../../shared/chrome-flag';
import { createScrubber } from './scrubber';
import {
  enabledDestinations,
  getTelemetrySettings,
  hasDestinationConfigured,
  isExperimentEnabled,
  migrateLegacySecrets,
  normalizeSampleRate,
  updateTelemetrySettings,
  withDestination,
  type TelemetrySettings,
} from './settings';
import { readSecrets } from './secret-store';
import type { ExportRecord } from './types';
import { loadSdk } from './lazy-chunks';
import type { SdkDestination } from './destinations/types';
import { getAdapter, resolveEntry } from './destinations/registry';
import { recordingLevel } from './filters';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import type { TelemetryDestinationKind } from '../../shared/telemetry/settings-types';
import { previousSessionVersion, setStartupKind } from './lifecycle';

const LOG_NS = 'core:telemetry';


let starting: Promise<boolean> | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
/** Destinations exporting in the current runtime. */
let activeDestinations: Array<{ id: string; kind: TelemetryDestinationKind }> = [];
/** Per destination id: why it could not start this time. */
let destinationStartErrors = new Map<string, string>();

let lastStartError: string | undefined;

/**
 * Synchronous pre-check, safe before `ready`: the flag is on, consent is
 * recorded and some enabled destination looks configured. Secrets are decrypted and
 * validated in start(), after `ready`.
 */
export function isTelemetryConfigured(settings: TelemetrySettings = getTelemetrySettings()): boolean {
  return (
    isExperimentEnabled() &&
    // Consent is recorded before anything is exported. Phase 1 files predate
    // it (consentVersion 0), so those users are asked once in Settings.
    settings.consentVersion >= TELEMETRY_CONSENT_VERSION &&
    hasDestinationConfigured(settings)
  );
}

/** Why the last start failed, in plain words (shown in Settings). */
export function getLastStartError(): string | undefined {
  return lastStartError;
}

export function isRunning(): boolean {
  return getRuntime() !== null;
}

/** Destinations exporting right now, in settings order. */
export function getActiveDestinations(): ReadonlyArray<{ id: string; kind: TelemetryDestinationKind }> {
  return activeDestinations;
}

/** Why an enabled destination is not exporting, if it failed to start. */
export function getDestinationStartError(id: string): string | undefined {
  return destinationStartErrors.get(id);
}

/** The level the SDK records at for these settings: the most verbose enabled destination. */
export function configuredRecordingLevel(settings: TelemetrySettings = getTelemetrySettings()): TelemetryLevel {
  return recordingLevel(enabledDestinations(settings).map((d) => d.level));
}

const START_ERRORS: Record<string, string> = {
  missing_destination: 'No destination is configured.',
  feedback_not_connected: 'Connect Feedback (Settings, Feedback) to send telemetry to the developer.',
  missing_connection_string: 'No connection string is saved.',
  invalid_instrumentation_key: 'The connection string has no valid InstrumentationKey.',
  missing_ingestion_endpoint: 'The connection string has no IngestionEndpoint.',
  not_azure_ingestion_host: 'The ingestion endpoint is not an Application Insights host.',
  https_required: 'The endpoint must use HTTPS (plain HTTP is allowed only for localhost).',
  invalid_url: 'The endpoint is not a valid URL.',
  credentials_in_url: 'The endpoint must not contain a username or password.',
  invalid_header_name: 'A header name is not a valid HTTP token.',
  reserved_header_name: 'A header name is reserved.',
};

export function describeDestinationError(reason: string): string {
  return START_ERRORS[reason] ?? 'The destination is not valid.';
}

function annexRole(): ResourceInputs['annexRole'] {
  try {
    // Lazy: annex-settings is cheap, but keep bootstrap's static graph minimal.
    const { getSettings } = require('../services/annex-settings') as typeof import('../services/annex-settings');
    const s = getSettings();
    if (s.enableServer && s.enableClient) return 'both';
    if (s.enableServer) return 'satellite';
    if (s.enableClient) return 'controller';
  } catch {
    // Settings unreadable: report none.
  }
  return 'none';
}

/**
 * The chrome shell for this session. The renderer reads the same experimental
 * flag once at startup and switching takes effect on the next launch, so the
 * value cannot change mid-session (docs/chrome-redesign-spec.md §4.1, §8).
 */
function uiChrome(): ResourceInputs['uiChrome'] {
  try {
    const { getSettings } = require('../services/experimental-settings') as typeof import('../services/experimental-settings');
    return getSettings()[NEW_CHROME_FLAG] === true ? 'v2' : 'legacy';
  } catch {
    // Settings unreadable: the renderer falls back to the legacy shell too.
    return 'legacy';
  }
}

/** Ports of Clubhouse's own loopback servers; OTLP must never post into them. */
function clubhousePorts(): number[] {
  const ports: number[] = [];
  const read = (fn: () => number | number[]) => {
    try {
      ports.push(...([] as number[]).concat(fn()));
    } catch {
      // Service not loaded or not listening.
    }
  };
  // Lazy: these services are heavy and only needed when a connection opens.
  read(() => (require('../services/hook-server') as typeof import('../services/hook-server')).getPort());
  read(() => (require('../services/clubhouse-mcp/bridge-server') as typeof import('../services/clubhouse-mcp/bridge-server')).getPort());
  read(() => {
    const status = (require('../services/annex-server') as typeof import('../services/annex-server')).getStatus();
    return [status.port, status.pairingPort];
  });
  return ports;
}

/**
 * Second line of defence behind the consent dialog: never send to a host the
 * user hasn't confirmed. A lone destination with consent on record and no
 * confirmed host yet (a file from before every kind recorded one) is exactly
 * what the user consented to, so it is adopted as confirmed.
 */
export function checkConfirmedHost(confirmedHost: string | undefined, host: string, enabledCount: number): 'ok' | 'adopt' | 'refuse' {
  if (confirmedHost === host) return 'ok';
  if (confirmedHost === undefined && enabledCount === 1) return 'adopt';
  return 'refuse';
}

async function ensureIdentity(settings: TelemetrySettings): Promise<TelemetryIdentity> {
  if (isValidIdentity(settings)) return { installId: settings.installId, hashSalt: settings.hashSalt };
  const identity = createIdentity();
  await updateTelemetrySettings((s) => ({ ...s, ...identity }));
  return identity;
}

function startOfflinePrune(): void {
  stopOfflinePrune();
  const prune = () => {
    pruneOfflineDir(getOfflineDir()).catch(() => {});
  };
  prune();
  pruneTimer = setInterval(prune, OFFLINE_PRUNE_INTERVAL_MS);
  pruneTimer.unref?.();
}

function stopOfflinePrune(): void {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}

async function start(): Promise<boolean> {
  if (!isTelemetryConfigured()) {
    abortPending();
    return false;
  }
  const t0 = Date.now();
  try {
    // safeStorage (the secret store) only works once the app is ready.
    await app.whenReady();
    await migrateLegacySecrets().catch((err) => {
      appLog(LOG_NS, 'warn', 'Could not move the Phase 1 telemetry secret to secure storage', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
    const settings = getTelemetrySettings();
    const secrets = await readSecrets();
    const errors = new Map<string, string>();
    const ctx = { offlineDir: getOfflineDir(), reservedPorts: clubhousePorts };
    // Each enabled destination starts on its own: one that is misconfigured
    // or fails to load never stops the others.
    const enabled = enabledDestinations(settings);
    const adopt: Array<{ id: string; host: string }> = [];
    const built = await Promise.all(enabled.map(async (entry): Promise<SdkDestination | null> => {
      const { adapter, config, validation } = resolveEntry(entry, settings, secrets);
      if (!config || !validation.ok) {
        errors.set(entry.id, describeDestinationError('reason' in validation ? validation.reason : 'missing_destination'));
        return null;
      }
      const hostCheck = checkConfirmedHost(entry.confirmedHost, validation.host, enabled.length);
      if (hostCheck === 'adopt') adopt.push({ id: entry.id, host: validation.host });
      if (hostCheck === 'refuse') {
        errors.set(entry.id, 'The destination host changed or was never confirmed. Turn it off and on again to confirm it.');
        return null;
      }
      try {
        const exporters = await adapter.createExporters(config, entry, ctx);
        return {
          id: entry.id,
          kind: entry.kind,
          exporters,
          filter: { level: entry.level, preset: entry.preset },
          copyResourceAttributes: adapter.copyResourceAttributes,
        };
      } catch (err) {
        errors.set(entry.id, 'This destination failed to start. See the local log for details.');
        appLog(LOG_NS, 'warn', 'Telemetry destination failed to start', {
          meta: { destination: entry.id, error: err instanceof Error ? err.message : String(err) },
        });
        return null;
      }
    }));
    const destinations = built.filter((d): d is SdkDestination => d !== null);
    destinationStartErrors = errors;
    for (const { id, host } of adopt) {
      await updateTelemetrySettings((s) => withDestination(s, id, (d) => ({ ...d, confirmedHost: host })));
    }
    if (destinations.length === 0) {
      lastStartError = errors.values().next().value ?? describeDestinationError('missing_destination');
      abortPending();
      return false;
    }
    const identity = await ensureIdentity(settings);
    const level = recordingLevel(destinations.map((d) => d.filter.level));
    const { startSdk } = await loadSdk();

    const homeDir = os.homedir();
    let username: string | undefined;
    try {
      username = os.userInfo().username;
    } catch {
      username = undefined;
    }

    const runtime = startSdk({
      level,
      sampleRate: normalizeSampleRate(settings.sampleRate),
      destinations,
      hashSalt: Buffer.from(identity.hashSalt, 'base64'),
      scrub: createScrubber({ homeDir, username, hostname: os.hostname() }),
      resourceAttributes: buildResourceAttributes({
        appVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        arch: process.arch,
        osRelease: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
        nodeVersion: process.versions.node,
        electronVersion: process.versions.electron ?? 'unknown',
        installId: identity.installId,
        instanceId,
        annexRole: annexRole(),
        uiChrome: uiChrome(),
      }),
      diagLog: (lvl, message) => appLog(LOG_NS, lvl, `OpenTelemetry: ${message}`),
      exportLog: (lvl, message, meta) => appLog(LOG_NS, lvl, message, { meta }),
    });
    activeDestinations = destinations.map((d) => ({ id: d.id, kind: d.kind as TelemetryDestinationKind }));
    lastStartError = undefined;
    setRuntime(runtime);
    if (activeDestinations.some((d) => getAdapter(d.kind).usesOfflineQueue)) startOfflinePrune();
    appLog(LOG_NS, 'info', 'Telemetry export started', {
      meta: { destinations: activeDestinations.map((d) => d.id).join(','), level, initMs: Date.now() - t0 },
    });
    return true;
  } catch (err) {
    lastStartError = 'Telemetry failed to start. See the local log for details.';
    abortPending();
    appLog(LOG_NS, 'warn', 'Telemetry unavailable: SDK failed to start', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}

/**
 * Called once, synchronously, at the top of main/index.ts after the userData
 * override. Returns immediately; the SDK loads in the background.
 */
/**
 * Move a Phase 1 plaintext secret out of telemetry-settings.json once the app
 * is ready, whatever the flags say: a user who turned telemetry or the
 * experiment off must not keep the plaintext forever.
 */
export async function migrateLegacySecretsOnReady(): Promise<void> {
  await app.whenReady();
  try {
    if (!getTelemetrySettings().legacyDestination) return;
    if (!(await migrateLegacySecrets())) {
      appLog(LOG_NS, 'warn', 'Secure storage is unavailable: the Phase 1 telemetry secret stays in plaintext in telemetry-settings.json until it is cleared in Settings or storage becomes available');
    }
  } catch (err) {
    appLog(LOG_NS, 'warn', 'Could not move the Phase 1 telemetry secret to secure storage', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export function initTelemetry(): void {
  // Local recording (spec §6.12) has its own switch and starts synchronously,
  // so startup signals are recorded even with no export destination.
  void syncLocalRecording();
  try {
    if (getTelemetrySettings().legacyDestination) void migrateLegacySecretsOnReady();
    if (!isTelemetryConfigured()) return;
  } catch {
    return;
  }
  beginPending();
  starting = start().finally(() => {
    starting = null;
  });
}

/**
 * `clubhouse.app.sessions` (spec §4.1). Called from the `ready` handler after
 * the safe-mode decision, so the startup kind is known. Buffered by the
 * facade if the SDK is still loading.
 */
export function recordAppSession(): void {
  if (!isTelemetryActive()) return;
  const settings = getTelemetrySettings();
  const version = app.getVersion();
  // The session record is written whenever signals are produced, export or
  // not, so the startup kind is the same either way (spec §6.12 parity).
  // lastVersion covers files from before the record carried a version.
  const previous = previousSessionVersion() ?? settings.lastVersion;
  const kind =
    process.env.CLUBHOUSE_SAFE_MODE === '1'
      ? 'safe_mode'
      : previous && previous !== version
        ? 'after_update'
        : 'cold';
  setStartupKind(kind);
  tel.count('clubhouse.app.sessions', 1, [ATTR.startupKind(kind)]);
  // Only while exporting: local recording alone never creates
  // telemetry-settings.json or an install id.
  if (isExportActive() && settings.lastVersion !== version) {
    updateTelemetrySettings((s) => ({ ...s, lastVersion: version })).catch(() => {});
  }
}

/** Runtime enable (no restart needed). Resolves true once exporting. */
export async function enableTelemetry(): Promise<boolean> {
  if (getRuntime()) return true;
  if (starting) return starting;
  beginPending();
  starting = start().finally(() => {
    starting = null;
  });
  const ok = await starting;
  if (ok) emitEnabled();
  return ok;
}

/** `clubhouse.telemetry.enabled`, once per active destination kind (spec §6.11). */
function emitEnabled(): void {
  for (const kind of new Set(activeDestinations.map((d) => d.kind))) {
    tel.event('clubhouse.telemetry.enabled', [ATTR.telemetryDestination(kind)]);
  }
}

/**
 * Runtime disable: send `clubhouse.telemetry.disabled` as the last record,
 * flush (3 s), shut the providers down, stop renderer emission and delete the
 * offline queue. `deleteLocalData` also removes the install id and salt.
 */
async function stopRuntime({ emitDisabled, clearOffline }: { emitDisabled: boolean; clearOffline: boolean }): Promise<void> {
  if (starting) await starting;
  const rt = getRuntime();
  if (rt) {
    if (emitDisabled) rt.event('clubhouse.telemetry.disabled');
    setRuntime(null);
    await rt.shutdown(DEFAULT_FLUSH_TIMEOUT_MS);
  }
  abortPending();
  stopOfflinePrune();
  activeDestinations = [];
  if (clearOffline) await deleteOfflineData().catch(() => {});
}

/**
 * Apply changed settings to a running exporter: flush and shut down the old
 * one, then start with the new settings. `clearOffline` is set when the
 * destination changed, so nothing queued for one destination is ever sent to
 * another (spec §6.8).
 */
export async function restartTelemetry({ clearOffline = false } = {}): Promise<boolean> {
  await stopRuntime({ emitDisabled: false, clearOffline });
  if (!isTelemetryConfigured()) return false;
  beginPending();
  starting = start().finally(() => {
    starting = null;
  });
  const ok = await starting;
  if (ok) emitEnabled();
  return ok;
}

export async function disableTelemetry({ deleteLocalData = false } = {}): Promise<void> {
  await stopRuntime({ emitDisabled: true, clearOffline: true });
  if (deleteLocalData) {
    await updateTelemetrySettings((s) => {
      const next = { ...s };
      delete next.installId;
      delete next.hashSalt;
      return next;
    });
    // The running local recorder still holds the deleted salt.
    await restartLocalRecording();
  }
}

export interface TestEventResult {
  ok: boolean;
  reason?: 'not_enabled';
  latencyMs?: number;
  /** Export results for the test's span and event. */
  exports?: ExportRecord[];
}

/**
 * `clubhouse.telemetry.test` (spec §6.8): a span and an event, then a flush.
 * Both carry the target's id in `clubhouse.telemetry.destination`, and the
 * destination filters let them through only to that destination, so each
 * destination's "Send test event" tests just that destination.
 */
export async function sendTestEvent(destinationId: string, timeoutMs = 10_000): Promise<TestEventResult> {
  if (starting) await starting;
  const rt = getRuntime();
  const target = activeDestinations.find((d) => d.id === destinationId);
  if (!rt || !target) return { ok: false, reason: 'not_enabled' };
  // Ids are the kinds today, so the registry's destination enum carries the id.
  const attrs = [ATTR.telemetryDestination(target.id as TelemetryDestinationKind)];
  const t0 = Date.now();
  // Straight to the runtime: a destination check must work under either
  // parity policy, even with local recording off.
  rt.flow('clubhouse.telemetry.test', { attrs }, (): void => undefined);
  rt.event('clubhouse.telemetry.test', attrs);
  await rt.forceFlush(timeoutMs);
  const exports = rt.recentExports(t0).filter((r) => r.signal !== 'metrics' && r.destination === destinationId);
  return { ok: exports.length > 0 && exports.every((r) => r.ok), latencyMs: Date.now() - t0, exports };
}

/** Resolves when an in-flight startup finishes (tests, test event). */
export async function whenStarted(): Promise<boolean> {
  if (starting) return starting;
  return getRuntime() !== null;
}
