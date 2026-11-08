/**
 * Telemetry lifecycle (spec §6.7): startup, runtime enable/disable, test
 * event and offline-queue maintenance. Everything is gated behind recorded
 * consent plus an enabled destination in telemetry-settings.json.
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
import { newChromeEnabled } from '../window-chrome';
import { createScrubber } from './scrubber';
import {
  enabledDestinations,
  getTelemetrySettings,
  applyExportGraduation,
  developerDestinationBlocker,
  exportPermitted,
  findDestination,
  takeDeveloperRuleSwitchedOff,
  hasDestinationConfigured,
  migrateLegacySecrets,
  normalizeSampleRate,
  preserveSuspendedFlagFile,
  updateTelemetrySettings,
  withDestination,
  type TelemetrySettings,
} from './settings';
import { readSecrets } from './secret-store';
import type { ExportRecord } from './types';
import { loadSdk } from './lazy-chunks';
import type { SdkDestination } from './destinations/types';
import { getAdapter, resolveEntry } from './destinations/registry';
import { getFramebriarTelemetrySource } from './destinations/framebriar-source';
import { recordingLevel } from './filters';
import type { TelemetryLevel } from '../../shared/telemetry/attributes';
import { TELEMETRY_CONSENT_VERSION, type TelemetryDestinationKind } from '../../shared/telemetry/settings-types';
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
 * Synchronous pre-check, safe before `ready`: consent is recorded and some
 * enabled destination looks configured. Secrets are decrypted and
 * validated in start(), after `ready`.
 */
export function isTelemetryConfigured(settings: TelemetrySettings = getTelemetrySettings()): boolean {
  return (
    // Consent is recorded before anything is exported. Phase 1 files predate
    // it (consentVersion 0), so those users are asked once in Settings.
    exportPermitted(settings) &&
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
 * The chrome shell for this session, as the windows were told. Switching takes
 * effect on the next launch, so the value cannot change mid-session
 * (docs/chrome-redesign-spec.md §4.1, §8).
 */
export function uiChrome(): ResourceInputs['uiChrome'] {
  return newChromeEnabled() ? 'v2' : 'legacy';
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
          dropAttributes: adapter.dropAttributes,
          itemAttributes: adapter.itemAttributes,
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
    // Signals held for Framebriar go to Framebriar only, not to a destination the user turned on meanwhile.
    if (framebriarHoldTimer && !destinations.some((d) => d.kind === 'framebriar')) abortPending();
    endFramebriarHold();
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
 * is ready, whatever the settings say: a user who turned telemetry off, or had
 * it switched off when export left Experimental, must not keep the plaintext forever.
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

/** Log what the graduation did and clear what a switched-off setup leaves behind. Never throws. */
function finishExportGraduation(graduation: NonNullable<ReturnType<typeof applyExportGraduation>>): void {
  appLog(LOG_NS, 'info', 'Telemetry export settings migrated for this install', { meta: { outcome: graduation.outcome } });
  // As turning a destination off does: a queue from before must not be sent if it's turned on again.
  if (graduation.outcome === 'off' || graduation.outcome === 'opted_out') void deleteOfflineData().catch(() => {});
  graduation.saved.catch((err) => {
    // telemetry-exempt: logged; this run uses the migrated settings and the next launch saves again.
    appLog(LOG_NS, 'warn', 'Could not save the telemetry export settings migration', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  });
}

export function initTelemetry(): void {
  // Before anything reads the settings to decide: local recording's level
  // migration below included, and a Feedback sync can't come sooner.
  const graduation = applyExportGraduation();
  try {
    preserveSuspendedFlagFile();
  } catch (err) {
    // telemetry-exempt: logged; this run stays paused and the next launch tries again. The code only: never the file's contents.
    appLog(LOG_NS, 'warn', 'Could not keep a copy of the unreadable settings file', {
      meta: { code: (err as NodeJS.ErrnoException)?.code ?? 'unknown' },
    });
  }
  // Local recording (spec §6.12) has its own switch and starts synchronously,
  // so startup signals are recorded even with no export destination.
  void syncLocalRecording();
  if (graduation) finishExportGraduation(graduation);
  try {
    if (getTelemetrySettings().legacyDestination) void migrateLegacySecretsOnReady();
    if (!isTelemetryConfigured()) {
      const held = awaitingFramebriar(getTelemetrySettings());
      if (held) holdForFramebriar();
      logExportGates(getTelemetrySettings(), held ? 'held_for_feedback' : 'not_started');
      return;
    }
    logExportGates(getTelemetrySettings(), 'starting');
  } catch {
    return;
  }
  beginPending();
  starting = start().finally(() => {
    starting = null;
  });
}

/**
 * One local line at startup with every export gate (#2523): which one stops
 * export, if any, so a quiet install can be explained from its log. Booleans
 * and state names only, never a host, endpoint or token.
 */
function logExportGates(settings: TelemetrySettings, outcome: 'starting' | 'held_for_feedback' | 'not_started'): void {
  const consent = settings.consentVersion >= TELEMETRY_CONSENT_VERSION;
  const configured = hasDestinationConfigured(settings);
  appLog(LOG_NS, 'info', 'Telemetry export at startup', {
    meta: {
      outcome,
      blockedBy: outcome === 'starting' ? null : !consent ? 'no_consent' : settings.exportSuspended !== undefined ? 'paused' : !configured ? 'no_destination_configured' : 'unknown',
      consent,
      paused: settings.exportSuspended ?? null,
      enabled: enabledDestinations(settings).map((d) => d.kind),
      configured,
      developer: developerDestinationBlocker(settings) ?? 'wanted',
      developerRuleSwitchedOff: takeDeveloperRuleSwitchedOff(),
    },
  });
}

/** How long startup signals wait for Feedback to restore its enrollment (#2522). */
export const FRAMEBRIAR_STARTUP_HOLD_MS = 120_000;
let framebriarHoldTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The developer destination is the one that would export, and only Feedback
 * is missing: consent recorded, a confirmed host, not switched off by the
 * user. Feedback restores its enrollment long after init (#2522).
 */
function awaitingFramebriar(settings: TelemetrySettings): boolean {
  const entry = findDestination(settings, 'framebriar');
  return !!entry && exportPermitted(settings) && !!entry.confirmedHost && !entry.framebriar?.userOff
    && getFramebriarTelemetrySource()?.() == null;
}

/**
 * Buffer startup signals (app.startup, app.sessions, early exceptions) for
 * Feedback. When it connects, syncFramebriarDestination starts the runtime,
 * which replays them. If it doesn't connect in time, they are dropped, as
 * when any destination fails to start.
 */
function holdForFramebriar(): void {
  beginPending();
  endFramebriarHold();
  framebriarHoldTimer = setTimeout(() => {
    framebriarHoldTimer = null;
    if (!getRuntime() && !starting) abortPending();
  }, FRAMEBRIAR_STARTUP_HOLD_MS);
  framebriarHoldTimer.unref?.();
}

function endFramebriarHold(): void {
  if (framebriarHoldTimer) clearTimeout(framebriarHoldTimer);
  framebriarHoldTimer = null;
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
