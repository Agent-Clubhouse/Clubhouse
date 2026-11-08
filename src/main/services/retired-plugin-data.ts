import * as fsp from 'fs/promises';
import * as path from 'path';
import { appLog } from './log-service';
import { RETIRED_PLUGINS, isRetiredPlugin } from '../../shared/retired-plugins';

/**
 * Data left by retired Workshop plugins (Lounge, KanBoss, Bug Report; #2756).
 * Nothing here deletes anything: the data stays where the plugin wrote it, and
 * this module only finds it, logs it once, and exports a copy on request.
 */

export interface RetiredPluginDataOptions {
  /** `~/.clubhouse/plugin-data` */
  globalPluginDataDir: string;
  /** `~/.clubhouse/plugins`, where the plugin itself is installed. */
  communityPluginsDir: string;
  /** Every known project. */
  projects: readonly { id: string; path: string }[];
}

export type RetiredDataScope = 'global' | 'project' | 'project-local';

export interface RetiredDataLocation {
  scope: RetiredDataScope;
  /** Set for the two project scopes. */
  projectPath?: string;
  dir: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Where a retired plugin's data lives on this machine, in the order a person would look. */
export async function findRetiredPluginData(pluginId: string, opts: RetiredPluginDataOptions): Promise<{
  installed: boolean;
  locations: RetiredDataLocation[];
}> {
  if (!isRetiredPlugin(pluginId)) throw new Error(`"${pluginId}" is not a retired plugin`);
  const candidates: RetiredDataLocation[] = [{ scope: 'global', dir: path.join(opts.globalPluginDataDir, pluginId) }];
  for (const project of opts.projects) {
    candidates.push({ scope: 'project-local', projectPath: project.path, dir: path.join(project.path, '.clubhouse', 'plugin-data-local', pluginId) });
    candidates.push({ scope: 'project', projectPath: project.path, dir: path.join(project.path, '.clubhouse', 'plugin-data', pluginId) });
  }
  const locations: RetiredDataLocation[] = [];
  for (const candidate of candidates) {
    if (await exists(candidate.dir)) locations.push(candidate);
  }
  return { installed: await exists(path.join(opts.communityPluginsDir, pluginId)), locations };
}

/** Every file under `dir`, relative to it, skipping symlinks. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await fsp.readdir(path.join(dir, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(dir, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files;
}

export interface RetiredDataExport {
  plugin: string;
  name: string;
  exportedAt: string;
  locations: Array<{
    scope: RetiredDataScope;
    projectPath?: string;
    dir: string;
    /** Each file by its path relative to `dir` (forward slashes): parsed JSON, or the text when it isn't JSON. */
    files: Record<string, unknown>;
  }>;
}

const MAX_EXPORT_FILE_BYTES = 10 * 1024 * 1024;

/**
 * A readable copy of everything a retired plugin stored: JSON files parsed,
 * anything else as text. Files over 10 MB are listed but not inlined.
 */
export async function buildRetiredPluginExport(pluginId: string, opts: RetiredPluginDataOptions, now = new Date()): Promise<RetiredDataExport> {
  const { locations } = await findRetiredPluginData(pluginId, opts);
  const out: RetiredDataExport = { plugin: pluginId, name: RETIRED_PLUGINS[pluginId].name, exportedAt: now.toISOString(), locations: [] };
  for (const location of locations) {
    const files: Record<string, unknown> = {};
    for (const rel of await listFiles(location.dir)) {
      const key = rel.split(path.sep).join('/');
      const full = path.join(location.dir, rel);
      const { size } = await fsp.stat(full);
      if (size > MAX_EXPORT_FILE_BYTES) {
        files[key] = `(not included: ${size} bytes; the file is at ${full})`;
        continue;
      }
      const text = await fsp.readFile(full, 'utf-8');
      try {
        files[key] = JSON.parse(text);
      } catch {
        files[key] = text;
      }
    }
    out.locations.push({ ...location, files });
  }
  return out;
}

/**
 * Log once per retired plugin that is still installed or still has data, so
 * support can see why it stopped loading and where its data is. The ids
 * already logged are kept in `markerFile`; a read or write failure only means
 * the line may be logged again.
 */
export async function noteRetiredPlugins(opts: RetiredPluginDataOptions & { markerFile: string }): Promise<string[]> {
  let logged: string[] = [];
  try {
    const parsed = JSON.parse(await fsp.readFile(opts.markerFile, 'utf-8'));
    if (Array.isArray(parsed)) logged = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // No marker yet, or unreadable.
  }
  const noted: string[] = [];
  for (const pluginId of Object.keys(RETIRED_PLUGINS)) {
    if (logged.includes(pluginId)) continue;
    try {
      const { installed, locations } = await findRetiredPluginData(pluginId, opts);
      if (!installed && locations.length === 0) continue;
      appLog('core:plugins', 'info', `${RETIRED_PLUGINS[pluginId].name} was retired and no longer loads. Its data was kept.`, {
        meta: { pluginId, installed, dataDirs: locations.map((l) => l.dir) },
      });
      noted.push(pluginId);
    } catch (err) {
      appLog('core:plugins', 'warn', `Couldn't check data for retired plugin "${pluginId}"`, {
        meta: { pluginId, error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
  if (noted.length > 0) {
    try {
      await fsp.mkdir(path.dirname(opts.markerFile), { recursive: true });
      await fsp.writeFile(opts.markerFile, JSON.stringify([...logged, ...noted]), 'utf-8');
    } catch {
      // Logged again next launch; harmless.
    }
  }
  return noted;
}
