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
 * refuses any plugin whose manifest declares these ids, so an installed copy
 * of one is removed with its data.
 */
export const RETIRED_WORKSHOP_PLUGIN_IDS: readonly string[] = Object.keys(RETIRED_PLUGINS);

/** Marker the old keep-and-log path wrote (`_system/retired-plugins-noted.json`). */
export const RETIRED_NOTED_MARKER = 'retired-plugins-noted.json';

/** Folders this cleanup kept and already logged (`_system/retired-plugins-kept.json`), so each is logged once. */
export const RETIRED_KEPT_MARKER = 'retired-plugins-kept.json';

export interface RetiredPluginCleanupOptions {
  /** `~/.clubhouse/plugin-data` */
  globalPluginDataDir: string;
  /** Where community plugins are installed (`~/.clubhouse/plugins`). */
  communityPluginsDir: string;
  /** Every known project. */
  projects: readonly { id: string; path: string }[];
}

export type KeptReason =
  /** The project's repository tracks files in the folder. */
  | 'tracked'
  /** Git couldn't say whether the folder is tracked. */
  | 'unknown'
  /** An install folder holding a git checkout. */
  | 'git-checkout'
  /** A folder named like a retired plugin whose manifest declares another plugin, or none. */
  | 'not-retired-plugin';

export interface RetiredPluginCleanupResult {
  /** Every path that was deleted. */
  removed: string[];
  /** Folders left in place, and why. */
  kept: Array<{ path: string; reason: KeptReason }>;
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

/** Git's message for a folder outside every repository (LC_ALL=C keeps it in English). */
const OUTSIDE_REPO = /not a git repository \(or any of the parent directories\)/i;

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
      { cwd: projectPath, timeout: 15_000, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.length > 0 ? 'tracked' : 'untracked');
          return;
        }
        resolve(OUTSIDE_REPO.test(String(stderr)) ? 'untracked' : 'unknown');
      },
    );
  });
}

/** The id an install folder's manifest declares, or undefined when it has no readable manifest. */
async function manifestId(dir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8'));
    const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined;
    return typeof id === 'string' ? id : undefined;
  } catch { // telemetry-exempt: no readable manifest is an answer the caller handles
    return undefined;
  }
}

class Cleanup {
  readonly result: RetiredPluginCleanupResult = { removed: [], kept: [] };
  private readonly keptMarkerFile: string;
  private alreadyLogged: string[] = [];
  private readonly newlyLogged: string[] = [];

  constructor(private readonly opts: RetiredPluginCleanupOptions) {
    this.keptMarkerFile = path.join(opts.globalPluginDataDir, '_system', RETIRED_KEPT_MARKER);
  }

  async loadKeptMarker(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.keptMarkerFile, 'utf-8'));
      if (Array.isArray(parsed)) this.alreadyLogged = parsed.filter((k): k is string => typeof k === 'string');
    } catch { // telemetry-exempt: no marker yet; kept folders are logged again
    }
  }

  async saveKeptMarker(): Promise<void> {
    if (this.newlyLogged.length === 0) return;
    try {
      await fsp.mkdir(path.dirname(this.keptMarkerFile), { recursive: true });
      await fsp.writeFile(this.keptMarkerFile, JSON.stringify([...this.alreadyLogged, ...this.newlyLogged]), 'utf-8');
    } catch { // telemetry-exempt: the kept folders are logged again next launch; harmless
    }
  }

  /** Leaves `dir` in place; logs it the first time, never again. */
  keep(dir: string, reason: KeptReason, pluginId: string): void {
    this.result.kept.push({ path: dir, reason });
    const key = `${reason}:${dir}`;
    if (this.alreadyLogged.includes(key) || this.newlyLogged.includes(key)) return;
    this.newlyLogged.push(key);
    const why: Record<KeptReason, string> = {
      tracked: 'the project\'s repository tracks files in it. Delete it if you don\'t need it.',
      unknown: 'couldn\'t check whether the project\'s repository tracks it.',
      'git-checkout': 'it holds a git checkout. Delete it if you don\'t need it.',
      'not-retired-plugin': 'its manifest doesn\'t declare the retired plugin.',
    };
    appLog('core:plugins', 'info', `Kept ${dir}: ${why[reason]}`, { meta: { pluginId, dir, reason } });
  }

  /** A folder inside a project: deleted only when git tracks nothing in it (or the project isn't a repository). */
  async removeProjectFolder(pluginId: string, projectPath: string, relativeDir: string): Promise<void> {
    const dir = path.join(projectPath, relativeDir);
    if (!(await exists(dir))) return;
    const state = await gitTrackedState(projectPath, relativeDir.split(path.sep).join('/'));
    if (state === 'untracked') await removeIfPresent(dir, this.result.removed);
    else this.keep(dir, state, pluginId);
  }

  /** Global storage, the exact settings kv files, and per-project local storage for one plugin id. */
  async removePluginStorage(pluginId: string): Promise<void> {
    await removeIfPresent(path.join(this.opts.globalPluginDataDir, pluginId), this.result.removed);

    // Settings keys are exact (`settings-<scope>-<id>`). Never pattern-match,
    // or a plugin like `my-hub` would lose its settings too.
    const systemKvDir = path.join(this.opts.globalPluginDataDir, '_system', 'kv');
    for (const scope of ['app', ...this.opts.projects.map((p) => p.id)]) {
      const file = path.join(systemKvDir, `settings-${scope}-${pluginId}.json`);
      await removeIfPresent(file, this.result.removed);
      await removeIfPresent(`${file}.bak`, this.result.removed);
    }

    for (const project of this.opts.projects) {
      await this.removeProjectFolder(pluginId, project.path, path.join('.clubhouse', 'plugin-data-local', pluginId));
    }
  }

  /**
   * Installed copies of retired Workshop plugins, found by what their manifest
   * declares, in whatever folder they sit. A folder is removed when its
   * manifest declares a retired id, or, with no readable manifest, when it is a
   * marketplace install (`.marketplace`) named for one. A real folder holding
   * `.git` is never removed. A symlinked install loses the link only.
   */
  async removeInstalls(): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.opts.communityPluginsDir);
    } catch { // telemetry-exempt: no plugins folder, nothing installed
      return;
    }
    for (const name of entries) {
      const dir = path.join(this.opts.communityPluginsDir, name);
      try {
        const declared = await manifestId(dir);
        const namedRetired = RETIRED_WORKSHOP_PLUGIN_IDS.includes(name);
        const retiredId = declared !== undefined
          ? (RETIRED_WORKSHOP_PLUGIN_IDS.includes(declared) ? declared : undefined)
          : (namedRetired && await exists(path.join(dir, '.marketplace')) ? name : undefined);
        if (!retiredId) {
          if (namedRetired) this.keep(dir, 'not-retired-plugin', name);
          continue;
        }
        const isLink = (await fsp.lstat(dir)).isSymbolicLink();
        if (!isLink && await exists(path.join(dir, '.git'))) {
          this.keep(dir, 'git-checkout', retiredId);
          continue;
        }
        await removeIfPresent(dir, this.result.removed);
      } catch (err) { // telemetry-exempt: logged; best effort, retried next launch
        appLog('core:plugins', 'warn', `Failed to check installed plugin folder "${name}"`, {
          meta: { dir, error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
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
 * Retired Workshop plugins (Lounge, KanBoss, Bug Report): the same, plus
 * installed copies (see Cleanup.removeInstalls) and project storage
 * (`<project>/.clubhouse/plugin-data/<id>`).
 *
 * Folders inside a project are deleted only when git tracks nothing in them,
 * or the project isn't a repository; otherwise they are kept and logged once.
 * `~/.clubhouse/agent-queues` and `~/.clubhouse/assistant` aren't touched: they
 * can hold an agent's results and a chat history that exist nowhere else durable.
 * Best-effort: failures are logged, never thrown.
 */
export async function cleanupRetiredPluginData(opts: RetiredPluginCleanupOptions): Promise<RetiredPluginCleanupResult> {
  const cleanup = new Cleanup(opts);
  await cleanup.loadKeptMarker();

  for (const pluginId of RETIRED_BUILTIN_PLUGIN_IDS) {
    try {
      if (await exists(path.join(opts.communityPluginsDir, pluginId))) continue;
      await cleanup.removePluginStorage(pluginId);
    } catch (err) { // telemetry-exempt: logged; best effort, retried next launch
      appLog('core:plugins', 'warn', `Failed to clean up data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  await cleanup.removeInstalls();
  for (const pluginId of RETIRED_WORKSHOP_PLUGIN_IDS) {
    try {
      await cleanup.removePluginStorage(pluginId);
      for (const project of opts.projects) {
        await cleanup.removeProjectFolder(pluginId, project.path, path.join('.clubhouse', 'plugin-data', pluginId));
      }
    } catch (err) { // telemetry-exempt: logged; best effort, retried next launch
      appLog('core:plugins', 'warn', `Failed to clean up data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  try {
    await removeIfPresent(path.join(opts.globalPluginDataDir, '_system', RETIRED_NOTED_MARKER), cleanup.result.removed);
  } catch { // telemetry-exempt: a leftover marker is harmless and retried next launch
  }
  await cleanup.saveKeptMarker();

  if (cleanup.result.removed.length > 0) {
    appLog('core:plugins', 'info', 'Removed data left by retired plugins', {
      meta: { removed: cleanup.result.removed },
    });
  }
  return cleanup.result;
}
