import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import { pathExists } from './fs-utils';
import { IPC } from '../../shared/ipc-channels';
import { appLog } from './log-service';
import { broadcastToAllWindows } from '../util/ipc-broadcast';
import { fetchAllRegistries, installPlugin } from './marketplace-service';
import { listCustomMarketplaces } from './custom-marketplace-service';
import { isNewerVersion } from './auto-update-service';
import type {
  PluginUpdateInfo,
  IncompatiblePluginUpdate,
  PluginUpdateCheckResult,
  PluginUpdatesStatus,
  PluginUpdateResult,
} from '../../shared/marketplace-types';
import { SUPPORTED_PLUGIN_API_VERSIONS } from '../../shared/marketplace-types';
import { isValidPluginId } from '../../shared/manifest-validator';
import { tel } from '../telemetry/facade';
import { classifyFetchError } from '../telemetry/workspace';
import { ATTR } from '../../shared/telemetry/attributes';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours (same as app updates)
const STARTUP_DELAY_MS = 60_000; // 1 minute after startup

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let status: PluginUpdatesStatus = {
  updates: [],
  incompatibleUpdates: [],
  checking: false,
  lastCheck: null,
  updating: {},
  error: null,
};

let checkTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCommunityPluginsDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugins');
}

/**
 * Read installed community plugin manifests from disk.
 * Returns a map of pluginId -> { version, pluginPath }.
 */
async function getInstalledPlugins(): Promise<Map<string, { version: string; name: string; pluginPath: string }>> {
  const pluginsDir = getCommunityPluginsDir();
  const installed = new Map<string, { version: string; name: string; pluginPath: string }>();

  if (!await pathExists(pluginsDir)) return installed;

  const entries = await fsp.readdir(pluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!await pathExists(manifestPath)) continue;

    try {
      const raw = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'));
      if (raw.id && raw.version) {
        installed.set(raw.id, {
          version: raw.version,
          name: raw.name || raw.id,
          pluginPath: path.join(pluginsDir, entry.name),
        });
      }
    } catch {
      // Skip malformed manifests
    }
  }

  return installed;
}

function broadcastStatus(): void {
  broadcastToAllWindows(IPC.MARKETPLACE.PLUGIN_UPDATES_CHANGED, { ...status });
}

// ---------------------------------------------------------------------------
// Core update check
// ---------------------------------------------------------------------------

type UpdateTrigger = Parameters<typeof ATTR.updateTrigger>[0];

/** The last failed check's error, for telemetry classification only. */
let lastCheckError: unknown;

/**
 * Check for plugin updates, measured as `clubhouse.plugin.update_check`
 * (spec §4.11) with the trigger and the available/incompatible counts.
 * A call while a check is already running returns its state, unmeasured.
 */
export async function checkForPluginUpdates(trigger: UpdateTrigger = 'manual'): Promise<PluginUpdateCheckResult> {
  if (status.checking) {
    return { updates: status.updates, incompatibleUpdates: status.incompatibleUpdates, checkedAt: status.lastCheck || new Date().toISOString() };
  }
  lastCheckError = undefined;
  return tel.flow('clubhouse.plugin.update_check', { attrs: [ATTR.updateTrigger(trigger)] }, async (span) => {
    const result = await checkForPluginUpdatesNow();
    span.set(ATTR.updatesAvailable(result.updates.length), ATTR.updatesIncompatible(result.incompatibleUpdates.length));
    return result;
  }, { classify: () => (lastCheckError !== undefined ? { error: classifyFetchError(lastCheckError) } : 'ok') });
}

async function checkForPluginUpdatesNow(): Promise<PluginUpdateCheckResult> {

  status = { ...status, checking: true, error: null };
  broadcastStatus();

  appLog('marketplace:updates', 'info', 'Checking for plugin updates');

  try {
    const customMarketplaces = await listCustomMarketplaces();
    const { allPlugins } = await fetchAllRegistries(customMarketplaces);
    const installed = await getInstalledPlugins();
    const updates: PluginUpdateInfo[] = [];
    const incompatibleUpdates: IncompatiblePluginUpdate[] = [];

    for (const regPlugin of allPlugins) {
      const local = installed.get(regPlugin.id);
      if (!local) continue; // Not installed — skip

      const latestVersion = regPlugin.latest;
      if (!isNewerVersion(latestVersion, local.version)) continue; // Already up to date

      const release = regPlugin.releases[latestVersion];
      if (!release) continue; // No release artifact for latest version

      // Guard: skip updates that require an API version the host app doesn't support
      if (!SUPPORTED_PLUGIN_API_VERSIONS.includes(release.api)) {
        incompatibleUpdates.push({
          pluginId: regPlugin.id,
          pluginName: regPlugin.name,
          currentVersion: local.version,
          latestVersion,
          requiredApi: release.api,
        });
        appLog('marketplace:updates', 'info', `Skipping update for ${regPlugin.id}: requires API ${release.api}, supported: ${SUPPORTED_PLUGIN_API_VERSIONS.join(', ')}`);
        continue;
      }

      updates.push({
        pluginId: regPlugin.id,
        pluginName: regPlugin.name,
        currentVersion: local.version,
        latestVersion,
        assetUrl: release.asset,
        sha256: release.sha256,
        size: release.size,
        api: release.api,
      });
    }

    const checkedAt = new Date().toISOString();
    status = {
      ...status,
      updates,
      incompatibleUpdates,
      checking: false,
      lastCheck: checkedAt,
      error: null,
    };
    broadcastStatus();

    appLog('marketplace:updates', 'info', `Plugin update check complete: ${updates.length} update(s) available, ${incompatibleUpdates.length} incompatible`, {
      meta: { pluginIds: updates.map((u) => u.pluginId), incompatibleIds: incompatibleUpdates.map((u) => u.pluginId), checkedAt },
    });

    return { updates, incompatibleUpdates, checkedAt };
  } catch (err) {
    lastCheckError = err;
    const msg = err instanceof Error ? err.message : String(err);
    appLog('marketplace:updates', 'error', `Plugin update check failed: ${msg}`);
    status = { ...status, checking: false, error: msg };
    broadcastStatus();
    return { updates: status.updates, incompatibleUpdates: status.incompatibleUpdates, checkedAt: status.lastCheck || new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// Update a single plugin
// ---------------------------------------------------------------------------

/** `clubhouse.plugin.update` (spec §4.11); the install runs as a child span. */
export async function updatePlugin(pluginId: string): Promise<PluginUpdateResult> {
  return tel.flow('clubhouse.plugin.update', {
    attrs: [ATTR.pluginRef('other'), ATTR.pluginIdHash(pluginId), ATTR.pluginOrigin('marketplace')],
  }, () => updatePluginNow(pluginId), {
    classify: (r) => {
      if (r.success) return 'ok';
      if (r.error?.startsWith('Invalid plugin id')) return { error: 'invalid_id' };
      if (r.error === 'No update available for this plugin') return { error: 'no_update_available' };
      return { error: 'install_failed' };
    },
  });
}

async function updatePluginNow(pluginId: string): Promise<PluginUpdateResult> {
  // Installed ids come from on-disk manifests, which are not validated; never
  // let one name a path outside the plugins root.
  if (!isValidPluginId(pluginId)) {
    return { success: false, pluginId, error: `Invalid plugin id: ${JSON.stringify(pluginId)}` };
  }

  const updateInfo = status.updates.find((u) => u.pluginId === pluginId);
  if (!updateInfo) {
    return { success: false, pluginId, error: 'No update available for this plugin' };
  }

  // Mark as updating
  status = {
    ...status,
    updating: { ...status.updating, [pluginId]: 'downloading' },
  };
  broadcastStatus();

  appLog('marketplace:updates', 'info', `Updating plugin: ${pluginId} ${updateInfo.currentVersion} -> ${updateInfo.latestVersion}`);

  try {
    // Install the new version (reuses existing install logic which handles
    // download, SHA256 verification, staged extraction, and swapping out the
    // old version only once the new one validates — a failed update leaves
    // the current install in place)
    status = { ...status, updating: { ...status.updating, [pluginId]: 'installing' } };
    broadcastStatus();

    const result = await installPlugin({
      pluginId,
      version: updateInfo.latestVersion,
      assetUrl: updateInfo.assetUrl,
      sha256: updateInfo.sha256,
    });

    if (!result.success) {
      // Clean up updating state
      const { [pluginId]: _, ...restUpdating } = status.updating;
      status = { ...status, updating: restUpdating };
      broadcastStatus();
      return { success: false, pluginId, error: result.error };
    }

    // Mark as reloading (renderer will handle the hot-reload)
    status = { ...status, updating: { ...status.updating, [pluginId]: 'reloading' } };

    // Remove from the updates list since it's now installed
    status = {
      ...status,
      updates: status.updates.filter((u) => u.pluginId !== pluginId),
    };

    // Clear updating state
    const { [pluginId]: __, ...finalUpdating } = status.updating;
    status = { ...status, updating: finalUpdating };
    broadcastStatus();

    appLog('marketplace:updates', 'info', `Plugin ${pluginId} updated to ${updateInfo.latestVersion}`);

    return { success: true, pluginId, newVersion: updateInfo.latestVersion };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appLog('marketplace:updates', 'error', `Failed to update plugin ${pluginId}: ${msg}`);

    const { [pluginId]: ___, ...errUpdating } = status.updating;
    status = { ...status, updating: errUpdating };
    broadcastStatus();

    return { success: false, pluginId, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function getPluginUpdatesStatus(): PluginUpdatesStatus {
  return { ...status };
}

export function startPeriodicPluginUpdateChecks(): void {
  if (checkTimer) return;

  // Delayed initial check
  setTimeout(() => {
    checkForPluginUpdates('startup').catch(() => {});
  }, STARTUP_DELAY_MS);

  // Periodic checks
  checkTimer = setInterval(() => {
    checkForPluginUpdates('periodic').catch(() => {});
  }, CHECK_INTERVAL_MS);
}

export function stopPeriodicPluginUpdateChecks(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

/** @internal Reset state — exported for tests only. */
export function _resetState(): void {
  status = {
    updates: [],
    incompatibleUpdates: [],
    checking: false,
    lastCheck: null,
    updating: {},
    error: null,
  };
  stopPeriodicPluginUpdateChecks();
}
