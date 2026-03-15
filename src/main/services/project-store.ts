import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
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
function migrateProjectOverrides(oldId: string, newId: string): void {
  try {
    // Badge settings
    const badge = getBadgeSettings();
    if (badge.projectOverrides?.[oldId]) {
      badge.projectOverrides[newId] = badge.projectOverrides[oldId];
      delete badge.projectOverrides[oldId];
      saveBadgeSettings(badge);
    }
  } catch {
    // Non-critical — don't block add()
  }

  try {
    // Sound settings
    const sound = getSoundSettings();
    if (sound.projectOverrides?.[oldId]) {
      sound.projectOverrides[newId] = sound.projectOverrides[oldId];
      delete sound.projectOverrides[oldId];
      saveSoundSettings(sound);
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
  if (!await pathExists(storePath)) {
    return { version: CURRENT_VERSION, projects: [] };
  }
  try {
    const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
    const store = migrate(raw);
    // Re-write if we migrated from an older format
    if (!raw.version || raw.version !== CURRENT_VERSION) {
      appLog('core:project-store', 'info', 'Migrated project store from older format', {
        meta: { fromVersion: raw.version, toVersion: CURRENT_VERSION },
      });
      await writeStore(store);
    }
    return store;
  } catch (err) {
    appLog('core:project-store', 'error', 'Failed to parse projects.json, returning empty list', {
      meta: { storePath, error: err instanceof Error ? err.message : String(err) },
    });
    return { version: CURRENT_VERSION, projects: [] };
  }
}

async function writeStore(store: ProjectStoreV1): Promise<void> {
  const storePath = await getStorePath();
  await fsp.writeFile(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

async function readProjects(): Promise<Project[]> {
  return (await readStore()).projects;
}

async function writeProjects(projects: Project[]): Promise<void> {
  await writeStore({ version: CURRENT_VERSION, projects });
}

/**
 * Sequential read-modify-write the projects list to prevent lost updates
 * within a single Node.js process. The `fn` callback receives the current
 * projects array and must return a new array that will be written back to disk.
 * Callbacks should be pure transforms — avoid filesystem side effects inside.
 */
async function updateProjects(fn: (projects: Project[]) => Project[]): Promise<Project[]> {
  const projects = await readProjects();
  const updated = fn(projects);
  await writeProjects(updated);
  return updated;
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
    migrateProjectOverrides(restoredSettings._previousId, id);
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
  let removedProject: Project | undefined;
  await updateProjects((projects) => {
    removedProject = projects.find((p) => p.id === id);
    return projects.filter((p) => p.id !== id);
  });

  if (removedProject) {
    // Preserve user-configured settings for later re-add at the same path
    await preserveSettings(removedProject);
  }

  // Preserve the icon for later re-add at the same path; delete if no icon
  if (removedProject?.icon) {
    await preserveIcon(removedProject);
  } else {
    await removeIconFile(id);
  }
}

export async function update(id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'name' | 'displayName' | 'orchestrator'>>): Promise<Project[]> {
  let shouldRemoveIcon = false;

  const result = await updateProjects((projects) => {
    return projects.map((p) => {
      if (p.id !== id) return p;

      const next = { ...p };

      if (updates.icon === '') {
        shouldRemoveIcon = true;
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

      return next;
    });
  });

  // Perform filesystem side effect after the state write succeeds
  if (shouldRemoveIcon) {
    await removeIconFile(id);
  }

  return result;
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
