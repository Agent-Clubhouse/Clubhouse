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
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { appLog } from '../services/log-service';
import { ATTR } from '../../shared/telemetry/attributes';
import {
  abortPending,
  beginPending,
  DEFAULT_FLUSH_TIMEOUT_MS,
  getRuntime,
  isPending,
  setRuntime,
  tel,
} from './facade';
import { createIdentity, isValidIdentity, type TelemetryIdentity } from './ids';
import { deleteOfflineData, getOfflineDir, OFFLINE_PRUNE_INTERVAL_MS, pruneOfflineDir } from './offline';
import { buildResourceAttributes, type ResourceInputs } from './resource';
import { createScrubber } from './scrubber';
import {
  getTelemetrySettings,
  hasDestinationConfigured,
  isExperimentEnabled,
  migrateLegacySecrets,
  normalizeLevel,
  normalizeSampleRate,
  resolveDestination,
  updateTelemetrySettings,
  validateDestination,
  type DestinationConfig,
  type TelemetrySettings,
} from './settings';
import { readSecrets } from './secret-store';
import type { ExportRecord } from './types';
import { loadAzureDestination, loadOtlpDestination, loadSdk } from './lazy-chunks';
import type { DestinationExporters } from './destinations/types';

const LOG_NS = 'core:telemetry';

/** One id per app run; exported as service.instance.id. */
const instanceId = randomUUID();

let starting: Promise<boolean> | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let activeDestination: DestinationConfig['kind'] | null = null;

let lastStartError: string | undefined;

/**
 * Synchronous pre-check, safe before `ready`: the flag is on, telemetry is
 * enabled and a destination looks configured. Secrets are decrypted and
 * validated in start(), after `ready`.
 */
export function isTelemetryConfigured(settings: TelemetrySettings = getTelemetrySettings()): boolean {
  return isExperimentEnabled() && settings.enabled === true && hasDestinationConfigured(settings);
}

/** Why the last start failed, in plain words (shown in Settings). */
export function getLastStartError(): string | undefined {
  return lastStartError;
}

export function isRunning(): boolean {
  return getRuntime() !== null;
}

export function getActiveDestination(): DestinationConfig['kind'] | null {
  return activeDestination;
}

const START_ERRORS: Record<string, string> = {
  missing_destination: 'No destination is configured.',
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

async function ensureIdentity(settings: TelemetrySettings): Promise<TelemetryIdentity> {
  if (isValidIdentity(settings)) return { installId: settings.installId, hashSalt: settings.hashSalt };
  const identity = createIdentity();
  await updateTelemetrySettings((s) => ({ ...s, ...identity }));
  return identity;
}

async function loadExporters(dest: DestinationConfig, settings: TelemetrySettings): Promise<DestinationExporters> {
  if (dest.kind === 'azure') {
    const { createAzureExporters } = await loadAzureDestination();
    return createAzureExporters({ connectionString: dest.connectionString, storageDirectory: getOfflineDir() });
  }
  const { createOtlpExporters } = await loadOtlpDestination();
  return createOtlpExporters({
    endpoint: dest.endpoint,
    headers: dest.headers,
    reservedPorts: clubhousePorts,
    temporality: settings.otlpTemporality,
  });
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
    const destination = resolveDestination(settings, await readSecrets());
    const validation = validateDestination(destination);
    if (!destination || !validation.ok) {
      lastStartError = describeDestinationError('reason' in validation ? validation.reason : 'missing_destination');
      abortPending();
      return false;
    }
    const identity = await ensureIdentity(settings);
    const level = normalizeLevel(settings.level);
    const [{ startSdk }, exporters] = await Promise.all([loadSdk(), loadExporters(destination, settings)]);

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
      exporters,
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
        level,
        annexRole: annexRole(),
      }),
      diagLog: (lvl, message) => appLog(LOG_NS, lvl, `OpenTelemetry: ${message}`),
    });
    activeDestination = destination.kind;
    lastStartError = undefined;
    setRuntime(runtime);
    if (destination.kind === 'azure') startOfflinePrune();
    appLog(LOG_NS, 'info', 'Telemetry export started', {
      meta: { destination: destination.kind, level, initMs: Date.now() - t0 },
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
export function initTelemetry(): void {
  try {
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
  if (!getRuntime() && !isPending()) return;
  const settings = getTelemetrySettings();
  const version = app.getVersion();
  const kind =
    process.env.CLUBHOUSE_SAFE_MODE === '1'
      ? 'safe_mode'
      : settings.lastVersion && settings.lastVersion !== version
        ? 'after_update'
        : 'cold';
  tel.count('clubhouse.app.sessions', 1, [ATTR.startupKind(kind)]);
  if (settings.lastVersion !== version) {
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
  if (ok) tel.event('clubhouse.telemetry.enabled', activeDestination ? [ATTR.telemetryDestination(activeDestination)] : []);
  return ok;
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
  activeDestination = null;
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
  return starting;
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
 * The Settings "Send test event" button reports the exporter results.
 */
export async function sendTestEvent(timeoutMs = 10_000): Promise<TestEventResult> {
  if (starting) await starting;
  const rt = getRuntime();
  if (!rt) return { ok: false, reason: 'not_enabled' };
  const t0 = Date.now();
  tel.flow('clubhouse.telemetry.test', {}, (): void => undefined);
  tel.event('clubhouse.telemetry.test', activeDestination ? [ATTR.telemetryDestination(activeDestination)] : []);
  await rt.forceFlush(timeoutMs);
  const exports = rt.recentExports(t0).filter((r) => r.signal !== 'metrics');
  return { ok: exports.length > 0 && exports.every((r) => r.ok), latencyMs: Date.now() - t0, exports };
}

/** Resolves when an in-flight startup finishes (tests, test event). */
export async function whenStarted(): Promise<boolean> {
  if (starting) return starting;
  return getRuntime() !== null;
}
