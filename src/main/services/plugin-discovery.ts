import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { PluginManifest } from '../../shared/plugin-types';
import { getGlobalPluginDataDir } from './plugin-storage';

function getCommunityPluginsDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugins');
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  pluginPath: string;
  /** True when the plugin was installed via the marketplace (has .marketplace marker). */
  fromMarketplace: boolean;
}

export function discoverCommunityPlugins(): DiscoveredPlugin[] {
  const pluginsDir = getCommunityPluginsDir();
  if (!fs.existsSync(pluginsDir)) return [];

  const results: DiscoveredPlugin[] = [];
  try {
    const dirs = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const dir of dirs) {
      // Symlinks need stat() to check if target is a directory
      if (!dir.isDirectory()) {
        if (!dir.isSymbolicLink()) continue;
        try {
          const resolved = fs.statSync(path.join(pluginsDir, dir.name));
          if (!resolved.isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      }
      const manifestPath = path.join(pluginsDir, dir.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as PluginManifest;
        const pluginDir = path.join(pluginsDir, dir.name);
        const fromMarketplace = fs.existsSync(path.join(pluginDir, '.marketplace'));
        results.push({
          manifest,
          pluginPath: pluginDir,
          fromMarketplace,
        });
      } catch {
        // Invalid manifest, skip
      }
    }
  } catch {
    // plugins dir doesn't exist or can't be read
  }
  return results;
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  const pluginDir = path.join(getCommunityPluginsDir(), pluginId);

  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(pluginDir);
  } catch {
    return; // path doesn't exist — nothing to do
  }

  if (stat.isSymbolicLink()) {
    // Remove only the symlink, not the target directory
    await fs.promises.unlink(pluginDir);
  } else {
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }

  // Clean up the plugin's data directory (storage + files dataDir)
  const dataDir = path.join(getGlobalPluginDataDir(), pluginId);
  try {
    await fs.promises.rm(dataDir, { recursive: true, force: true });
  } catch {
    // Best-effort — data dir may not exist
  }
}
