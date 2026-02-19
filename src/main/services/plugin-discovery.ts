import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { PluginManifest } from '../../shared/plugin-types';

function getCommunityPluginsDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugins');
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  pluginPath: string;
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
        results.push({
          manifest,
          pluginPath: path.join(pluginsDir, dir.name),
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

export function uninstallPlugin(pluginId: string): void {
  const pluginDir = path.join(getCommunityPluginsDir(), pluginId);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
  }
}
