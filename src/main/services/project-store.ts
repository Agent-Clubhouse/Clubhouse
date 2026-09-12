import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import { Project } from '../../shared/types';
import { appLog } from './log-service';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';
import { pathExists } from './fs-utils';

const CURRENT_VERSION = 1;

interface ProjectStoreV1 {
  version: 1;
  projects: Project[];
}

async function getBaseDir(): Promise<string> {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  const dir = path.join(app.getPath('home'), dirName);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function getStorePath(): Promise<string> {
  return path.join(await getBaseDir(), 'projects.json');
}

async function getBackupPath(): Promise<string> {
  return path.join(await getBaseDir(), 'projects.json.bak');
}

async function getQuarantinePath(): Promise<string> {
  const timestamp = Date.now();
  return path.join(await getBaseDir(), `projects.json.corrupt-${timestamp}`);
}

async function getIconsDir(): Promise<string> {
  const dir = path.join(await getBaseDir(), 'project-icons');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Deterministic short hash for a filesystem path, used to key preserved icons. */
function pathHash(dirPath: string): string {
  return crypto.createHash('sha256').update(dirPath).digest('hex').slice(0, 16);
}

/**
 * Rename a project's icon file to a path-based preserved name so it can be
 * restored when the same directory is re-added as a project.
 */
async function preserveIcon(project: Project): Promise<void> {
  const iconsDir = await getIconsDir();
  try {
    const files = await fsp.readdir(iconsDir);
    const hash = pathHash(project.path);
    for (const file of files) {
      if (file.startsWith(project.id + '.')) {
        const ext = path.extname(file);
        await fsp.rename(
          path.join(iconsDir, file),
          path.join(iconsDir, `_preserved_${hash}${ext}`),
        );
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

/**
 * Stash user-configured project settings (displayName, color, orchestrator)
 * plus the old project ID to a JSON sidecar so they survive a remove → re-add
 * cycle at the same path. The old ID is needed to migrate ID-keyed overrides
 * in external settings files (badge-settings, sound-settings).
 */
async function preserveSettings(project: Project): Promise<void> {
  const settings: Record<string, string> = {};
  // Always save the project ID so we can migrate ID-keyed overrides on restore
  settings._previousId = project.id;
  if (project.displayName) settings.displayName = project.displayName;
  if (project.color) settings.color = project.color;
  if (project.orchestrator) settings.orchestrator = project.orchestrator;

  const hash = pathHash(project.path);
  const filePath = path.join(await getBaseDir(), `_preserved_${hash}.json`);
  await fsp.writeFile(filePath, JSON.stringify(settings), 'utf-8');
}

interface PreservedSettings extends Partial<Pick<Project, 'displayName' | 'color' | 'orchestrator'>> {
  _previousId?: string;
}

/**
 * Restore preserved settings for a project path. Returns partial project
 * fields (plus _previousId for override migration) and removes the stash
 * file. Returns empty object if none found.
 */
async function restorePreservedSettings(project: Project): Promise<PreservedSettings> {
  const hash = pathHash(project.path);
  const filePath = path.join(await getBaseDir(), `_preserved_${hash}.json`);
  try {
    if (!await pathExists(filePath)) return {};
    const data = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    await fsp.unlink(filePath);
    return data;
  } catch {
    return {};
  }
}

/**
 * Re-key project overrides in external settings files (badge-settings,
 * sound-settings) from the old project ID to the new one.
 */
async function migrateProjectOverrides(oldId: string, newId: string): Promise<void> {
  try {
    // Badge settings — await the write so the next read sees the migrated state
    const badge = getBadgeSettings();
    if (badge.projectOverrides?.[oldId]) {
      badge.projectOverrides[newId] = badge.projectOverrides[oldId];
      delete badge.projectOverrides[oldId];
      await saveBadgeSettings(badge);
    }
  } catch {
    // Non-critical — don't block add()
  }

  try {
    // Sound settings — await the write so the next read sees the migrated state
    const sound = getSoundSettings();
    if (sound.projectOverrides?.[oldId]) {
      sound.projectOverrides[newId] = sound.projectOverrides[oldId];
      delete sound.projectOverrides[oldId];
      await saveSoundSettings(sound);
    }
  } catch {
    // Non-critical — don't block add()
  }
}

/**
 * Check for a preserved icon for the given project path and, if found,
 * rename it to use the new project ID. Returns the new filename or null.
 */
async function restorePreservedIcon(project: Project): Promise<string | null> {
  const iconsDir = await getIconsDir();
  const hash = pathHash(project.path);
  try {
    const files = await fsp.readdir(iconsDir);
    for (const file of files) {
      if (file.startsWith(`_preserved_${hash}.`)) {
        const ext = path.extname(file);
        const newName = `${project.id}${ext}`;
        await fsp.rename(
          path.join(iconsDir, file),
          path.join(iconsDir, newName),
        );
        return newName;
      }
    }
  } catch {
    // icons dir may not exist yet
  }
  return null;
}

function migrate(raw: unknown): ProjectStoreV1 {
  // No file or unparseable → empty v1
  if (raw == null) {
    return { version: CURRENT_VERSION, projects: [] };
  }

  // v0: bare array (pre-versioning)
  if (Array.isArray(raw)) {
    return { version: CURRENT_VERSION, projects: raw as Project[] };
  }

  const obj = raw as Record<string, unknown>;

  // Already at current version
  if (obj.version === CURRENT_VERSION) {
    return obj as unknown as ProjectStoreV1;
  }

  // Future versions we don't understand — preserve projects array if present
  if (Array.isArray(obj.projects)) {
    return { version: CURRENT_VERSION, projects: obj.projects as Project[] };
  }

  return { version: CURRENT_VERSION, projects: [] };
}

async function readStore(): Promise<ProjectStoreV1> {
  const storePath = await getStorePath();
  const backupPath = await getBackupPath();

  appLog('core:project-store', 'debug', 'Reading project store from disk', {
    meta: { storePath, backupPath },
  });

  let store: ProjectStoreV1 | null = null;

  // Try to read main store
  if (await pathExists(storePath)) {
    try {
      const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
      store = migrate(raw);
      appLog('core:project-store', 'info', `Loaded ${store.projects.length} project(s) from disk`, {
        meta: { storePath, projects: store.projects.map((p) => ({ id: p.id, name: p.name })) },
      });
      // Re-write if we migrated from an older format
      if (raw.version == null || raw.version !== CURRENT_VERSION) {
        appLog('core:project-store', 'info', 'Migrated project store from older format', {
          meta: { fromVersion: (raw as Record<string, unknown>).version, toVersion: CURRENT_VERSION },
        });
        await writeStore(store);
      }
    } catch (err) {
      appLog('core:project-store', 'error', 'Failed to parse projects.json — quarantining and attempting recovery from backup', {
        meta: { storePath, error: err instanceof Error ? err.message : String(err) },
      });
      // Quarantine the corrupt file so it is not silently overwritten by the next write
      try {
        const quarantinePath = await getQuarantinePath();
        await fsp.rename(storePath, quarantinePath);
        appLog('core:project-store', 'info', 'Corrupt projects.json quarantined', {
          meta: { corrupted: storePath, quarantined: quarantinePath },
        });
      } catch (quarantineErr) {
        appLog('core:project-store', 'error', 'Failed to quarantine corrupt projects.json', {
          meta: { storePath, error: quarantineErr instanceof Error ? quarantineErr.message : String(quarantineErr) },
        });
      }
    }
  }

  // Main file missing or corrupt — fall back to backup
  if (!store && await pathExists(backupPath)) {
    try {
      const raw = JSON.parse(await fsp.readFile(backupPath, 'utf-8'));
      store = migrate(raw);
      if (store.projects.length > 0) {
        appLog('core:project-store', 'warn', `Recovered ${store.projects.length} project(s) from backup`, {
          meta: {
            backupPath,
            projects: store.projects.map((p) => ({ id: p.id, name: p.name })),
          },
        });
        // Restore backup to main file so future reads succeed
        await writeStore(store);
      }
    } catch (backupErr) {
      appLog('core:project-store', 'error', 'Backup projects.json.bak is also corrupt', {
        meta: { backupPath, error: backupErr instanceof Error ? backupErr.message : String(backupErr) },
      });
    }
  }

  if (!store) {
    appLog('core:project-store', 'info', 'No project store found on disk, starting with empty list', {
      meta: { storePath, backupPath },
    });
    return { version: CURRENT_VERSION, projects: [] };
  }

  return store;
}

async function writeStore(store: ProjectStoreV1): Promise<void> {
  const storePath = await getStorePath();
  const backupPath = await getBackupPath();

  // Back up existing projects.json before overwriting — the backup preserves
  // the last known-good state so that a crash mid-write or corrupt write
  // can be auto-recovered on the next read.
  if (await pathExists(storePath)) {
    try {
      await fsp.copyFile(storePath, backupPath);
    } catch {
      // Non-fatal — best-effort backup
    }
  }

  // Atomic write: write to temp file then rename — prevents partial/corrupt
  // files if the process crashes mid-write.
  const tmpPath = storePath + '.tmp.' + randomUUID().slice(0, 8);
  await fsp.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
  await fsp.rename(tmpPath, storePath);

  appLog('core:project-store', 'info', `Wrote ${store.projects.length} project(s) to disk`, {
    meta: { storePath, projectIds: store.projects.map((p) => p.id) },
  });
}

async function readProjects(): Promise<Project[]> {
  return (await readStore()).projects;
}

async function writeProjects(projects: Project[]): Promise<void> {
  await writeStore({ version: CURRENT_VERSION, projects });
}

let projectUpdateQueue: Promise<unknown> = Promise.resolve();

/**
 * Serialize project mutations behind a single in-process promise chain so
 * concurrent IPC operations cannot read the same stale snapshot and overwrite
 * one another.
 */
async function updateProjects(fn: (projects: Project[]) => Project[] | Promise<Project[]>): Promise<Project[]> {
  const run = async (): Promise<Project[]> => {
    const projects = await readProjects();
    const updated = await fn(projects);
    await writeProjects(updated);
    return updated;
  };

  const next = projectUpdateQueue.then(run, run);
  projectUpdateQueue = next.then((): void => undefined, (): void => undefined);
  return next;
}

export async function list(): Promise<Project[]> {
  return readProjects();
}

export async function add(dirPath: string): Promise<Project> {
  const name = path.basename(dirPath);
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const project: Project = { id, name, path: dirPath };

  // Restore preserved settings (displayName, color, orchestrator) from a previous session
  const restoredSettings = await restorePreservedSettings(project);
  if (restoredSettings.displayName) project.displayName = restoredSettings.displayName;
  if (restoredSettings.color) project.color = restoredSettings.color;
  if (restoredSettings.orchestrator) project.orchestrator = restoredSettings.orchestrator;

  // Migrate ID-keyed overrides in external settings files (badge, sound)
  if (restoredSettings._previousId) {
    await migrateProjectOverrides(restoredSettings._previousId, id);
  }

  // Restore a preserved icon from a previous session at this path
  const restoredIcon = await restorePreservedIcon(project);
  if (restoredIcon) {
    project.icon = restoredIcon;
  }

  await updateProjects((projects) => [...projects, project]);
  return project;
}

export async function remove(id: string): Promise<void> {
  await updateProjects(async (projects: Project[]): Promise<Project[]> => {
    const removedProject = projects.find((p) => p.id === id);

    if (removedProject) {
      await preserveSettings(removedProject);
      if (removedProject.icon) {
        await preserveIcon(removedProject);
      } else {
        await removeIconFile(id);
      }
    }

    return projects.filter((p) => p.id !== id);
  });
}

export async function update(id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'emoji' | 'name' | 'displayName' | 'orchestrator'>>): Promise<Project[]> {
  // Determine whether the icon file should be deleted before touching projects.json.
  // Deleting first avoids orphaned files if the process crashes between the JSON
  // write and the filesystem unlink (icon cleared from JSON but file never removed).
  const willClearIcon = updates.icon === '' || (updates.emoji !== undefined && updates.emoji !== '');
  if (willClearIcon) {
    await removeIconFile(id);
  }

  return updateProjects((projects) => {
    return projects.map((p) => {
      if (p.id !== id) return p;

      const next = { ...p };

      if (updates.icon === '') {
        delete next.icon;
      } else if (updates.icon !== undefined) {
        next.icon = updates.icon;
      }

      if (updates.color !== undefined) {
        if (updates.color === '') {
          delete next.color;
        } else {
          next.color = updates.color;
        }
      }

      if (updates.name !== undefined && updates.name !== '') {
        next.name = updates.name;
      }

      if (updates.displayName !== undefined) {
        if (updates.displayName === '') {
          delete next.displayName;
        } else {
          next.displayName = updates.displayName;
        }
      }

      if (updates.orchestrator !== undefined) {
        next.orchestrator = updates.orchestrator;
      }

      if (updates.emoji !== undefined) {
        if (updates.emoji === '') {
          delete next.emoji;
        } else {
          next.emoji = updates.emoji;
          // Emoji and image icon are mutually exclusive — clear image when emoji is set
          if (next.emoji) {
            delete next.icon;
          }
        }
      }

      return next;
    });
  });
}

export async function setIcon(projectId: string, sourcePath: string): Promise<string> {
  await removeIconFile(projectId);

  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const filename = `${projectId}${ext}`;
  const dest = path.join(await getIconsDir(), filename);
  await fsp.copyFile(sourcePath, dest);

  await updateProjects((projects) => {
    return projects.map((p) => {
      if (p.id !== projectId) return p;
      return { ...p, icon: filename };
    });
  });

  return filename;
}

export async function removeIconFile(projectId: string): Promise<void> {
  const iconsDir = await getIconsDir();
  try {
    const files = await fsp.readdir(iconsDir);
    for (const file of files) {
      if (file.startsWith(projectId + '.')) {
        await fsp.unlink(path.join(iconsDir, file));
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

export async function readIconData(filename: string): Promise<string | null> {
  const iconsDir = await getIconsDir();
  const filePath = path.resolve(iconsDir, filename);
  if (!filePath.startsWith(iconsDir + path.sep) && filePath !== iconsDir) {
    return null;
  }
  if (!await pathExists(filePath)) return null;

  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  const mime = mimeMap[ext] || 'image/png';
  const data = await fsp.readFile(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** Save a cropped PNG data URL as the project icon. Returns the filename. */
export async function saveCroppedIcon(projectId: string, dataUrl: string): Promise<string> {
  await removeIconFile(projectId);

  const filename = `${projectId}.png`;
  const dest = path.join(await getIconsDir(), filename);

  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  await fsp.writeFile(dest, Buffer.from(base64, 'base64'));

  await updateProjects((projects) => {
    return projects.map((p) => {
      if (p.id !== projectId) return p;
      return { ...p, icon: filename };
    });
  });

  return filename;
}

export async function reorder(orderedIds: string[]): Promise<Project[]> {
  return updateProjects((projects) => {
    const byId = new Map(projects.map((p) => [p.id, p]));

    const result: Project[] = [];
    for (const id of orderedIds) {
      const p = byId.get(id);
      if (p) {
        result.push(p);
        byId.delete(id);
      }
    }
    // Append any projects not in orderedIds (defensive)
    for (const p of byId.values()) {
      result.push(p);
    }

    return result;
  });
}
