import { execFile } from 'child_process';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';
import { RETIRED_PLUGINS } from '../../shared/retired-plugins';

/**
 * Built-in plugins that have been removed. Their on-disk data is deleted at
 * startup so old installs don't keep orphaned storage around. Keep in sync
 * with RETIRED_BUILTIN_PLUGIN_IDS in src/renderer/plugins/retired-plugins.ts.
 */
export const RETIRED_BUILTIN_PLUGIN_IDS: readonly string[] = ['hub', 'sessions', 'agent-queue'];

/**
 * Retired Workshop plugins (Lounge, KanBoss, Bug Report; #2756). Clubhouse
 * refuses any plugin with these ids, so an installed copy under the community
 * plugins dir is the retired plugin itself and is removed with its data.
 */
export const RETIRED_WORKSHOP_PLUGIN_IDS: readonly string[] = Object.keys(RETIRED_PLUGINS);

/** Marker the old keep-and-log path wrote (`_system/retired-plugins-noted.json`). */
export const RETIRED_NOTED_MARKER = 'retired-plugins-noted.json';

export interface RetiredPluginCleanupOptions {
  /** `~/.clubhouse/plugin-data` */
  globalPluginDataDir: string;
  /** Where community plugins are installed (`~/.clubhouse/plugins`). */
  communityPluginsDir: string;
  /** Every known project. */
  projects: readonly { id: string; path: string }[];
}

export interface RetiredPluginCleanupResult {
  /** Every path that was deleted. */
  removed: string[];
  /** Project folders left in place because the project's repository tracks files in them. */
  keptTracked: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch { // telemetry-exempt: a missing path is the answer, not a failure
    return false;
  }
}

/** Deletes `p` if present. `rm` never follows a symlink: a linked folder loses the link, not its target. */
async function removeIfPresent(p: string, removed: string[]): Promise<void> {
  if (!(await exists(p))) return;
  await fsp.rm(p, { recursive: true, force: true });
  removed.push(p);
}

type TrackedState = 'untracked' | 'tracked' | 'unknown';

/**
 * Whether the repository holding `projectPath` tracks any file under
 * `relativeDir`. A project that isn't in a git repository has nothing tracked.
 * Any other git failure (git missing, a broken repo) is `unknown`, and the
 * caller leaves the folder alone.
 */
export function gitTrackedState(projectPath: string, relativeDir: string): Promise<TrackedState> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['ls-files', '-z', '--', relativeDir],
      { cwd: projectPath, timeout: 15_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.length > 0 ? 'tracked' : 'untracked');
          return;
        }
        resolve(/not a git repository/i.test(String(stderr)) ? 'untracked' : 'unknown');
      },
    );
  });
}

/** Global storage, settings kv files and per-project local storage for one plugin id. */
async function removePluginStorage(
  pluginId: string,
  opts: RetiredPluginCleanupOptions,
  removed: string[],
): Promise<void> {
  await removeIfPresent(path.join(opts.globalPluginDataDir, pluginId), removed);

  // Settings keys are exact (`settings-<scope>-<id>`). Never pattern-match,
  // or a plugin like `my-hub` would lose its settings too.
  const systemKvDir = path.join(opts.globalPluginDataDir, '_system', 'kv');
  for (const scope of ['app', ...opts.projects.map((p) => p.id)]) {
    const file = path.join(systemKvDir, `settings-${scope}-${pluginId}.json`);
    await removeIfPresent(file, removed);
    await removeIfPresent(`${file}.bak`, removed);
  }

  for (const project of opts.projects) {
    await removeIfPresent(path.join(project.path, '.clubhouse', 'plugin-data-local', pluginId), removed);
  }
}

/**
 * A retired Workshop plugin's project-scope storage (`<project>/.clubhouse/plugin-data/<id>`)
 * can be committed to the person's repository. It is deleted only when git
 * tracks nothing in it (or the project isn't a repository).
 */
async function removeProjectStorage(
  pluginId: string,
  opts: RetiredPluginCleanupOptions,
  result: RetiredPluginCleanupResult,
): Promise<void> {
  for (const project of opts.projects) {
    const relativeDir = path.join('.clubhouse', 'plugin-data', pluginId);
    const dir = path.join(project.path, relativeDir);
    if (!(await exists(dir))) continue;
    const state = await gitTrackedState(project.path, relativeDir.split(path.sep).join('/'));
    if (state === 'untracked') {
      await removeIfPresent(dir, result.removed);
      continue;
    }
    result.keptTracked.push(dir);
    appLog('core:plugins', 'info', state === 'tracked'
      ? `Kept ${dir}: the project's repository tracks files in it. Delete it if you don't need it.`
      : `Kept ${dir}: couldn't check whether the project's repository tracks it.`, {
      meta: { pluginId, dir, state },
    });
  }
}

/**
 * Delete what removed plugins left behind.
 *
 * Removed built-ins (Hub, Sessions, Agent Queue):
 * - the plugin's global storage dir (`plugin-data/<id>`)
 * - its persisted settings (`plugin-data/_system/kv/settings-{app|<projectId>}-<id>.json[.bak]`)
 * - its per-project local storage (`<project>/.clubhouse/plugin-data-local/<id>`)
 * An id is skipped entirely when a community plugin with the same id is installed.
 *
 * Retired Workshop plugins (Lounge, KanBoss, Bug Report): the same, plus the
 * installed plugin (`plugins/<id>`) and project storage (`<project>/.clubhouse/plugin-data/<id>`)
 * that git doesn't track. Any plugin with these ids is refused, so there is no
 * community plugin to protect.
 *
 * `~/.clubhouse/agent-queues` and `~/.clubhouse/assistant` aren't touched: they
 * can hold an agent's results and a chat history that exist nowhere else durable.
 * Best-effort: failures are logged, never thrown.
 */
export async function cleanupRetiredPluginData(opts: RetiredPluginCleanupOptions): Promise<RetiredPluginCleanupResult> {
  const result: RetiredPluginCleanupResult = { removed: [], keptTracked: [] };

  for (const pluginId of RETIRED_BUILTIN_PLUGIN_IDS) {
    try {
      if (await exists(path.join(opts.communityPluginsDir, pluginId))) continue;
      await removePluginStorage(pluginId, opts, result.removed);
    } catch (err) { // telemetry-exempt: logged; best effort, retried next launch
      appLog('core:plugins', 'warn', `Failed to clean up data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  for (const pluginId of RETIRED_WORKSHOP_PLUGIN_IDS) {
    try {
      await removeIfPresent(path.join(opts.communityPluginsDir, pluginId), result.removed);
      await removePluginStorage(pluginId, opts, result.removed);
      await removeProjectStorage(pluginId, opts, result);
    } catch (err) { // telemetry-exempt: logged; best effort, retried next launch
      appLog('core:plugins', 'warn', `Failed to clean up data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  try {
    await removeIfPresent(path.join(opts.globalPluginDataDir, '_system', RETIRED_NOTED_MARKER), result.removed);
  } catch { // telemetry-exempt: a leftover marker is harmless and retried next launch
  }

  if (result.removed.length > 0) {
    appLog('core:plugins', 'info', 'Removed data left by retired plugins', {
      meta: { removed: result.removed },
    });
  }
  return result;
}
