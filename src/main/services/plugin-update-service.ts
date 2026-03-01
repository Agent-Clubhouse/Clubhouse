import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
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
function getInstalledPlugins(): Map<string, { version: string; name: string; pluginPath: string }> {
  const pluginsDir = getCommunityPluginsDir();
  const installed = new Map<string, { version: string; name: string; pluginPath: string }>();

  if (!fs.existsSync(pluginsDir)) return installed;

  const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
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

export async function checkForPluginUpdates(): Promise<PluginUpdateCheckResult> {
  if (status.checking) {
    return { updates: status.updates, checkedAt: status.lastCheck || new Date().toISOString() };
  }

  status = { ...status, checking: true, error: null };
  broadcastStatus();

  appLog('marketplace:updates', 'info', 'Checking for plugin updates');

  try {
    const customMarketplaces = listCustomMarketplaces();
    const { allPlugins } = await fetchAllRegistries(customMarketplaces);
    const installed = getInstalledPlugins();
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
    const msg = err instanceof Error ? err.message : String(err);
    appLog('marketplace:updates', 'error', `Plugin update check failed: ${msg}`);
    status = { ...status, checking: false, error: msg };
    broadcastStatus();
    return { updates: status.updates, checkedAt: status.lastCheck || new Date().toISOString() };
  }
}

// ---------------------------------------------------------------------------
// Update a single plugin
// ---------------------------------------------------------------------------

export async function updatePlugin(pluginId: string): Promise<PluginUpdateResult> {
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
    // download, SHA256 verification, extraction, and old version removal)
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
    checkForPluginUpdates().catch(() => {});
  }, STARTUP_DELAY_MS);

  // Periodic checks
  checkTimer = setInterval(() => {
    checkForPluginUpdates().catch(() => {});
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
