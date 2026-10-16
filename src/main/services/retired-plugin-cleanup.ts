import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';

/**
 * Built-in plugins that have been removed. Their on-disk data is deleted at
 * startup so old installs don't keep orphaned storage around. Keep in sync
 * with RETIRED_BUILTIN_PLUGIN_IDS in src/renderer/plugins/retired-plugins.ts.
 */
export const RETIRED_BUILTIN_PLUGIN_IDS: readonly string[] = ['hub', 'sessions', 'agent-queue'];

export interface RetiredPluginCleanupOptions {
  /** `~/.clubhouse/plugin-data` */
  globalPluginDataDir: string;
  /** Where community plugins are installed; a plugin dir with a retired ID there is left alone. */
  communityPluginsDir: string;
  /** Every known project. */
  projects: readonly { id: string; path: string }[];
  /**
   * Directories owned by removed features that aren't plugins (e.g. the
   * Assistant workspace, Agent Queue state). Deleted unconditionally.
   */
  retiredFeatureDirs?: readonly string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function removeIfPresent(p: string, removed: string[]): Promise<void> {
  if (!(await exists(p))) return;
  await fsp.rm(p, { recursive: true, force: true });
  removed.push(p);
}

/**
 * Delete storage left behind by retired built-in plugins:
 * - the plugin's global storage dir (`plugin-data/<id>`)
 * - its persisted settings (`plugin-data/_system/kv/settings-{app|<projectId>}-<id>.json[.bak]`)
 * - its per-project local storage (`<project>/.clubhouse/plugin-data-local/<id>`)
 *
 * Skips an ID entirely when a community plugin with the same ID is installed.
 * Best-effort: failures are logged, never thrown. Returns the removed paths.
 */
export async function cleanupRetiredPluginData(opts: RetiredPluginCleanupOptions): Promise<string[]> {
  const removed: string[] = [];
  const systemKvDir = path.join(opts.globalPluginDataDir, '_system', 'kv');

  for (const pluginId of RETIRED_BUILTIN_PLUGIN_IDS) {
    try {
      if (await exists(path.join(opts.communityPluginsDir, pluginId))) continue;

      await removeIfPresent(path.join(opts.globalPluginDataDir, pluginId), removed);

      // Settings keys are exact (`settings-<scope>-<id>`) — never pattern-match,
      // or a plugin like `my-hub` would lose its settings too.
      for (const scope of ['app', ...opts.projects.map((p) => p.id)]) {
        const file = path.join(systemKvDir, `settings-${scope}-${pluginId}.json`);
        await removeIfPresent(file, removed);
        await removeIfPresent(`${file}.bak`, removed);
      }

      for (const project of opts.projects) {
        await removeIfPresent(path.join(project.path, '.clubhouse', 'plugin-data-local', pluginId), removed);
      }
    } catch (err) {
      appLog('core:plugins', 'warn', `Failed to clean up data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  for (const dir of opts.retiredFeatureDirs ?? []) {
    try {
      await removeIfPresent(dir, removed);
    } catch (err) {
      appLog('core:plugins', 'warn', 'Failed to remove data for a retired feature', {
        meta: { dir, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  if (removed.length > 0) {
    appLog('core:plugins', 'info', 'Removed data left by retired built-in features', {
      meta: { removed },
    });
  }
  return removed;
}
