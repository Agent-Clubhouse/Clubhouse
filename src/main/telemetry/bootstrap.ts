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
  isExperimentEnabled,
  normalizeLevel,
  normalizeSampleRate,
  updateTelemetrySettings,
  validateDestination,
  type DestinationConfig,
  type TelemetrySettings,
} from './settings';
import { loadAzureDestination, loadOtlpDestination, loadSdk } from './lazy-chunks';
import type { DestinationExporters } from './destinations/types';

const LOG_NS = 'core:telemetry';

/** One id per app run; exported as service.instance.id. */
const instanceId = randomUUID();

let starting: Promise<boolean> | null = null;
let pruneTimer: NodeJS.Timeout | null = null;
let activeDestination: DestinationConfig['kind'] | null = null;

export function isTelemetryConfigured(settings: TelemetrySettings = getTelemetrySettings()): boolean {
  return isExperimentEnabled() && settings.enabled === true && validateDestination(settings.destination).ok;
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
    return getSettings().newChrome === true ? 'v2' : 'legacy';
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

async function ensureIdentity(settings: TelemetrySettings): Promise<TelemetryIdentity> {
  if (isValidIdentity(settings)) return { installId: settings.installId, hashSalt: settings.hashSalt };
  const identity = createIdentity();
  await updateTelemetrySettings((s) => ({ ...s, ...identity }));
  return identity;
}

async function loadExporters(dest: DestinationConfig): Promise<DestinationExporters> {
  if (dest.kind === 'azure') {
    const { createAzureExporters } = await loadAzureDestination();
    return createAzureExporters({ connectionString: dest.connectionString, storageDirectory: getOfflineDir() });
  }
  const { createOtlpExporters } = await loadOtlpDestination();
  return createOtlpExporters({ endpoint: dest.endpoint, headers: dest.headers, reservedPorts: clubhousePorts });
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
  const settings = getTelemetrySettings();
  if (!isTelemetryConfigured(settings) || !settings.destination) {
    abortPending();
    return false;
  }
  const t0 = Date.now();
  try {
    const identity = await ensureIdentity(settings);
    const level = normalizeLevel(settings.level);
    const [{ startSdk }, exporters] = await Promise.all([loadSdk(), loadExporters(settings.destination)]);

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
        uiChrome: uiChrome(),
      }),
      diagLog: (lvl, message) => appLog(LOG_NS, lvl, `OpenTelemetry: ${message}`),
    });
    activeDestination = settings.destination.kind;
    setRuntime(runtime);
    if (settings.destination.kind === 'azure') startOfflinePrune();
    appLog(LOG_NS, 'info', 'Telemetry export started', {
      meta: { destination: settings.destination.kind, level, initMs: Date.now() - t0 },
    });
    return true;
  } catch (err) {
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
export async function disableTelemetry({ deleteLocalData = false } = {}): Promise<void> {
  if (starting) await starting;
  const rt = getRuntime();
  if (rt) {
    rt.event('clubhouse.telemetry.disabled');
    setRuntime(null);
    await rt.shutdown(DEFAULT_FLUSH_TIMEOUT_MS);
  }
  abortPending();
  stopOfflinePrune();
  activeDestination = null;
  await deleteOfflineData().catch(() => {});
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
}

/**
 * `clubhouse.telemetry.test` (spec §6.8): a span and an event, then a flush.
 * Phase 2 wires this to the Settings "Send test event" button.
 */
export async function sendTestEvent(timeoutMs = 10_000): Promise<TestEventResult> {
  if (starting) await starting;
  const rt = getRuntime();
  if (!rt) return { ok: false, reason: 'not_enabled' };
  const t0 = Date.now();
  tel.flow('clubhouse.telemetry.test', {}, (): void => undefined);
  tel.event('clubhouse.telemetry.test', activeDestination ? [ATTR.telemetryDestination(activeDestination)] : []);
  await rt.forceFlush(timeoutMs);
  return { ok: true, latencyMs: Date.now() - t0 };
}

/** Resolves when an in-flight startup finishes (tests, test event). */
export async function whenStarted(): Promise<boolean> {
  if (starting) return starting;
  return getRuntime() !== null;
}
