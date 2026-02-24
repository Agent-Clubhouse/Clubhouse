import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { Project } from '../../shared/types';
import { appLog } from './log-service';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';

const CURRENT_VERSION = 1;

interface ProjectStoreV1 {
  version: 1;
  projects: Project[];
}

function getBaseDir(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  const dir = path.join(app.getPath('home'), dirName);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getStorePath(): string {
  return path.join(getBaseDir(), 'projects.json');
}

function getIconsDir(): string {
  const dir = path.join(getBaseDir(), 'project-icons');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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
function preserveIcon(project: Project): void {
  const iconsDir = getIconsDir();
  try {
    const files = fs.readdirSync(iconsDir);
    const hash = pathHash(project.path);
    for (const file of files) {
      if (file.startsWith(project.id + '.')) {
        const ext = path.extname(file);
        fs.renameSync(
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
function preserveSettings(project: Project): void {
  const settings: Record<string, string> = {};
  // Always save the project ID so we can migrate ID-keyed overrides on restore
  settings._previousId = project.id;
  if (project.displayName) settings.displayName = project.displayName;
  if (project.color) settings.color = project.color;
  if (project.orchestrator) settings.orchestrator = project.orchestrator;

  const hash = pathHash(project.path);
  const filePath = path.join(getBaseDir(), `_preserved_${hash}.json`);
  fs.writeFileSync(filePath, JSON.stringify(settings), 'utf-8');
}

interface PreservedSettings extends Partial<Pick<Project, 'displayName' | 'color' | 'orchestrator'>> {
  _previousId?: string;
}

/**
 * Restore preserved settings for a project path. Returns partial project
 * fields (plus _previousId for override migration) and removes the stash
 * file. Returns empty object if none found.
 */
function restorePreservedSettings(project: Project): PreservedSettings {
  const hash = pathHash(project.path);
  const filePath = path.join(getBaseDir(), `_preserved_${hash}.json`);
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    fs.unlinkSync(filePath);
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
function restorePreservedIcon(project: Project): string | null {
  const iconsDir = getIconsDir();
  const hash = pathHash(project.path);
  try {
    const files = fs.readdirSync(iconsDir);
    for (const file of files) {
      if (file.startsWith(`_preserved_${hash}.`)) {
        const ext = path.extname(file);
        const newName = `${project.id}${ext}`;
        fs.renameSync(
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

function readStore(): ProjectStoreV1 {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return { version: CURRENT_VERSION, projects: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    const store = migrate(raw);
    // Re-write if we migrated from an older format
    if (!raw.version || raw.version !== CURRENT_VERSION) {
      appLog('core:project-store', 'info', 'Migrated project store from older format', {
        meta: { fromVersion: raw.version, toVersion: CURRENT_VERSION },
      });
      writeStore(store);
    }
    return store;
  } catch (err) {
    appLog('core:project-store', 'error', 'Failed to parse projects.json, returning empty list', {
      meta: { storePath, error: err instanceof Error ? err.message : String(err) },
    });
    return { version: CURRENT_VERSION, projects: [] };
  }
}

function writeStore(store: ProjectStoreV1): void {
  const storePath = getStorePath();
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf-8');
}

function readProjects(): Project[] {
  return readStore().projects;
}

function writeProjects(projects: Project[]): void {
  writeStore({ version: CURRENT_VERSION, projects });
}

export function list(): Project[] {
  return readProjects();
}

export function add(dirPath: string): Project {
  const projects = readProjects();
  const name = path.basename(dirPath);
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const project: Project = { id, name, path: dirPath };

  // Restore preserved settings (displayName, color, orchestrator) from a previous session
  const restoredSettings = restorePreservedSettings(project);
  if (restoredSettings.displayName) project.displayName = restoredSettings.displayName;
  if (restoredSettings.color) project.color = restoredSettings.color;
  if (restoredSettings.orchestrator) project.orchestrator = restoredSettings.orchestrator;

  // Migrate ID-keyed overrides in external settings files (badge, sound)
  if (restoredSettings._previousId) {
    migrateProjectOverrides(restoredSettings._previousId, id);
  }

  // Restore a preserved icon from a previous session at this path
  const restoredIcon = restorePreservedIcon(project);
  if (restoredIcon) {
    project.icon = restoredIcon;
  }

  projects.push(project);
  writeProjects(projects);
  return project;
}

export function remove(id: string): void {
  const projects = readProjects();
  const project = projects.find((p) => p.id === id);
  const filtered = projects.filter((p) => p.id !== id);
  writeProjects(filtered);

  if (project) {
    // Preserve user-configured settings for later re-add at the same path
    preserveSettings(project);
  }

  // Preserve the icon for later re-add at the same path; delete if no icon
  if (project?.icon) {
    preserveIcon(project);
  } else {
    removeIconFile(id);
  }
}

export function update(id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'name' | 'displayName' | 'orchestrator'>>): Project[] {
  const projects = readProjects();
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return projects;

  if (updates.icon === '') {
    removeIconFile(id);
    delete projects[idx].icon;
  } else if (updates.icon !== undefined) {
    projects[idx].icon = updates.icon;
  }

  if (updates.color !== undefined) {
    if (updates.color === '') {
      delete projects[idx].color;
    } else {
      projects[idx].color = updates.color;
    }
  }

  if (updates.name !== undefined && updates.name !== '') {
    projects[idx].name = updates.name;
  }

  if (updates.displayName !== undefined) {
    if (updates.displayName === '') {
      delete projects[idx].displayName;
    } else {
      projects[idx].displayName = updates.displayName;
    }
  }

  if (updates.orchestrator !== undefined) {
    projects[idx].orchestrator = updates.orchestrator;
  }

  writeProjects(projects);
  return projects;
}

export function setIcon(projectId: string, sourcePath: string): string {
  removeIconFile(projectId);

  const ext = path.extname(sourcePath).toLowerCase() || '.png';
  const filename = `${projectId}${ext}`;
  const dest = path.join(getIconsDir(), filename);
  fs.copyFileSync(sourcePath, dest);

  const projects = readProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx !== -1) {
    projects[idx].icon = filename;
    writeProjects(projects);
  }

  return filename;
}

export function removeIconFile(projectId: string): void {
  const iconsDir = getIconsDir();
  try {
    const files = fs.readdirSync(iconsDir);
    for (const file of files) {
      if (file.startsWith(projectId + '.')) {
        fs.unlinkSync(path.join(iconsDir, file));
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

export function readIconData(filename: string): string | null {
  const filePath = path.join(getIconsDir(), filename);
  if (!fs.existsSync(filePath)) return null;

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
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}

/** Save a cropped PNG data URL as the project icon. Returns the filename. */
export function saveCroppedIcon(projectId: string, dataUrl: string): string {
  removeIconFile(projectId);

  const filename = `${projectId}.png`;
  const dest = path.join(getIconsDir(), filename);

  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(dest, Buffer.from(base64, 'base64'));

  const projects = readProjects();
  const idx = projects.findIndex((p) => p.id === projectId);
  if (idx !== -1) {
    projects[idx].icon = filename;
    writeProjects(projects);
  }

  return filename;
}

export function reorder(orderedIds: string[]): Project[] {
  const projects = readProjects();
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

  writeProjects(result);
  return result;
}
