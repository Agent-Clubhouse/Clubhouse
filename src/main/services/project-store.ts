import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { Project } from '../../shared/types';
import { appLog } from './log-service';
import { getSettings as getBadgeSettings, saveSettings as saveBadgeSettings } from './badge-settings';
import { getSettings as getSoundSettings, saveSettings as saveSoundSettings } from './sound-service';
import { pathExists } from './fs-utils';
import { persist } from '../telemetry/persist';
import { publishAppEvent } from './app-event-bus';
import { getBaseDirPath } from './base-dir';
import { auditChanges, type AuditKeyFormat } from './settings-audit';

const CURRENT_VERSION = 1;

interface ProjectStoreV1 {
  version: 1;
  projects: Project[];
}

async function getBaseDir(): Promise<string> {
  const dir = getBaseDirPath();
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
async function migrateProjectOverrides(oldId: string, newId: string, opts: { keepExisting?: boolean } = {}): Promise<void> {
  try {
    // Badge settings — await the write so the next read sees the migrated state
    const badge = getBadgeSettings();
    if (badge.projectOverrides?.[oldId]) {
      if (!opts.keepExisting || !badge.projectOverrides[newId]) badge.projectOverrides[newId] = badge.projectOverrides[oldId];
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
      if (!opts.keepExisting || !sound.projectOverrides[newId]) sound.projectOverrides[newId] = sound.projectOverrides[oldId];
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

/** Thrown when a parsed registry does not have a shape we can safely accept. */
class InvalidStoreError extends Error {}

function isValidProject(entry: unknown): entry is Project {
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const p = entry as Record<string, unknown>;
  return typeof p.id === 'string' && p.id !== ''
    && typeof p.name === 'string'
    && typeof p.path === 'string' && p.path !== '';
}

interface MigrateResult {
  store: ProjectStoreV1;
  /** Number of malformed entries dropped from the projects array. */
  dropped: number;
  /** Records for a folder already in the list, folded into the first one (#3236). */
  merged: MergedDuplicate[];
}

interface MergedDuplicate {
  keptId: string;
  mergedId: string;
  path: string;
}

/** Whether this platform's filesystems compare names without case by default (APFS, HFS+, NTFS). */
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/**
 * How two project paths are compared (#3236): absolute, normalized, and on
 * macOS and Windows without case (and on macOS in one Unicode form). Doesn't
 * touch the disk; {@link canonicalProjectPath} resolves links first.
 */
export function projectPathKey(dirPath: string): string {
  let key = path.resolve(dirPath);
  if (process.platform === 'darwin') key = key.normalize('NFC');
  return CASE_INSENSITIVE_FS ? key.toLowerCase() : key;
}

/** The folder's real path, links resolved, or the plain absolute path when it can't be read. */
export async function canonicalProjectPath(dirPath: string): Promise<string> {
  try {
    return await fsp.realpath(dirPath);
  } catch {
    // telemetry-exempt: a missing or unreadable folder is compared by its plain path
    return path.resolve(dirPath);
  }
}

/**
 * The registered project for a folder, matched by canonical path: the same
 * folder through a link, another spelling or another case (where the platform
 * ignores case) is the same project.
 */
async function findByCanonicalPath(projects: readonly Project[], dirPath: string): Promise<Project | undefined> {
  const plain = projectPathKey(dirPath);
  const real = projectPathKey(await canonicalProjectPath(dirPath));
  for (const p of projects) {
    const key = projectPathKey(p.path);
    if (key === plain || key === real) return p;
  }
  for (const p of projects) {
    if (projectPathKey(await canonicalProjectPath(p.path)) === real) return p;
  }
  return undefined;
}

/** Fields a merged duplicate can fill in on the record that's kept, when the kept one has none. */
const MERGED_FIELDS = ['displayName', 'color', 'orchestrator'] as const;

/**
 * Fold records for the same folder into the first one (#3236). Agents live in
 * the folder, so both records already share them; the kept record takes any
 * name, color, orchestrator or picture only the other one had.
 */
function mergeDuplicates(projects: Project[]): { projects: Project[]; merged: MergedDuplicate[] } {
  const byKey = new Map<string, number>();
  const out: Project[] = [];
  const merged: MergedDuplicate[] = [];
  for (const p of projects) {
    const key = projectPathKey(p.path);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(p);
      continue;
    }
    const kept = { ...out[at] };
    for (const field of MERGED_FIELDS) {
      if (!kept[field] && p[field]) (kept as Record<string, unknown>)[field] = p[field];
    }
    if (!kept.icon && !kept.emoji) {
      if (p.icon) kept.icon = p.icon;
      else if (p.emoji) kept.emoji = p.emoji;
    }
    out[at] = kept;
    merged.push({ keptId: kept.id, mergedId: p.id, path: p.path });
  }
  return { projects: out, merged };
}

/**
 * Validate and normalise a parsed projects.json payload. Throws
 * InvalidStoreError for shapes we don't understand (e.g. `{}`, `null`, a
 * non-array `projects`) so the caller treats them like a corrupt file —
 * quarantine and fall back to the backup — rather than as a legitimate empty
 * registry. Malformed individual entries are dropped; valid ones are kept.
 */
function migrate(raw: unknown): MigrateResult {
  let entries: unknown[];

  if (Array.isArray(raw)) {
    // v0: bare array (pre-versioning)
    entries = raw;
  } else if (raw != null && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).projects)) {
    // v1, or a future version we don't fully understand — preserve its projects array
    entries = (raw as Record<string, unknown>).projects as unknown[];
  } else {
    throw new InvalidStoreError('Unrecognised project store shape');
  }

  const valid = entries.filter(isValidProject);
  const dropped = entries.length - valid.length;
  if (dropped > 0 && valid.length === 0) {
    // Every entry is malformed — don't let that become a "successful" empty registry.
    throw new InvalidStoreError(`All ${dropped} project entries are malformed`);
  }
  const { projects, merged } = mergeDuplicates(valid);
  return { store: { version: CURRENT_VERSION, projects }, dropped, merged };
}

/**
 * Whether the on-disk projects.json is fully valid and therefore safe to
 * rotate into projects.json.bak. An invalid or partially-malformed primary
 * must never replace a (possibly healthy) backup.
 */
async function isRotatableStore(storePath: string): Promise<boolean> {
  try {
    const { dropped } = migrate(JSON.parse(await fsp.readFile(storePath, 'utf-8')));
    return dropped === 0;
  } catch {
    return false;
  }
}

let lastLoggedProjects: string | null = null;

/**
 * Every list() reads the file, many times a second under Annex and agent
 * activity, and this line carries the whole project list. It's only news when
 * the list differs, and repeats of it used up the diag budget (#2662).
 */
function logLoadedIfChanged(storePath: string, store: ProjectStoreV1): void {
  const projects = store.projects.map((p) => ({ id: p.id, name: p.name }));
  const key = JSON.stringify(projects);
  if (key === lastLoggedProjects) return;
  lastLoggedProjects = key;
  appLog('core:project-store', 'info', `Loaded ${projects.length} project(s) from disk`, {
    meta: { storePath, projects },
  });
}

// Includes recovery/migration writes, not only user mutation entry points. A pending
// libuv write can finish without a JS callback between another service's checks.
let registryGeneration = 0;
let registryPending = 0;
export function projectRegistryMutationState(): { generation: number; pending: boolean } {
  return { generation: registryGeneration, pending: registryPending > 0 };
}
async function registryMutation<T>(run: () => Promise<T>): Promise<T> {
  registryGeneration++; registryPending++;
  try { return await run(); }
  finally { registryPending--; }
}

// Retained for the one-time chat tip: quarantine can make a failed read look
// like a fresh install on a subsequent list in the same process.
let chatTipProjectReadUncertain = false;
export function isChatTipProjectReadUncertain(): boolean { return chatTipProjectReadUncertain; }

async function readStore(): Promise<ProjectStoreV1> {
  const storePath = await getStorePath();
  const backupPath = await getBackupPath();

  let store: ProjectStoreV1 | null = null;
  let uncertain = false;

  // Try to read main store
  if (await pathExists(storePath)) {
  try {
      const raw = JSON.parse(await fsp.readFile(storePath, 'utf-8'));
      const { store: loaded, dropped, merged } = migrate(raw);
      store = loaded;
      uncertain = dropped > 0;
      if (dropped > 0) {
        appLog('core:project-store', 'warn', `Dropped ${dropped} malformed project entr${dropped === 1 ? 'y' : 'ies'} from projects.json`, {
          meta: { storePath, dropped },
        });
      }
      logLoadedIfChanged(storePath, store);
      if (merged.length > 0) {
        appLog('core:project-store', 'warn', `Merged ${merged.length} duplicate project record(s) for a folder already registered`, {
          meta: { storePath, merged: merged.map((m) => ({ keptId: m.keptId, mergedId: m.mergedId })) },
        });
        for (const m of merged) await migrateProjectOverrides(m.mergedId, m.keptId, { keepExisting: true });
        try {
          await writeStore(store);
        } catch (writeErr) {
          // telemetry-exempt: logged; the merged list is still served, and the next read merges again
          appLog('core:project-store', 'warn', 'Could not write the merged project list', {
            meta: { storePath, error: writeErr instanceof Error ? writeErr.message : String(writeErr) },
          });
        }
      } else if (raw.version == null || raw.version !== CURRENT_VERSION) {
        // Re-write if we migrated from an older format
        appLog('core:project-store', 'info', 'Migrated project store from older format', {
          meta: { fromVersion: (raw as Record<string, unknown>).version, toVersion: CURRENT_VERSION },
        });
        await writeStore(store);
      }
    } catch (err) {
      uncertain = true;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      appLog('core:project-store', 'error', 'Failed to parse or validate projects.json — quarantining and attempting recovery from backup', {
        meta: { storePath, error: err instanceof Error ? err.message : String(err) },
      });
      persist.recovery('projects', 'primary_corrupt');
      // Quarantine the corrupt file so it is not silently overwritten by the next write
      try {
        const quarantinePath = await registryMutation(async () => {
          const destination = await getQuarantinePath();
          await fsp.rename(storePath, destination); return destination;
        });
        persist.recovery('projects', 'quarantined');
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

  } else {
    try { await fsp.readFile(storePath, 'utf-8'); uncertain = true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uncertain = true; } // telemetry-exempt: retained for the tip
  }

  // Main file missing or corrupt — fall back to backup
  const backupExists = !store && await pathExists(backupPath);
  if (backupExists) {
    try {
      const raw = JSON.parse(await fsp.readFile(backupPath, 'utf-8'));
      const recovered = migrate(raw);
      store = recovered.store;
      uncertain = recovered.dropped > 0;
      if (store.projects.length > 0) {
        persist.recovery('projects', 'restored_from_backup');
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
      uncertain = true;
      if ((backupErr as NodeJS.ErrnoException).code !== 'ENOENT') {
      persist.recovery('projects', 'backup_corrupt');
      appLog('core:project-store', 'error', 'Backup projects.json.bak is also corrupt', {
        meta: { backupPath, error: backupErr instanceof Error ? backupErr.message : String(backupErr) },
      });
      }
    }
  }

  if (!store && !backupExists) {
    try { await fsp.readFile(backupPath, 'utf-8'); uncertain = true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uncertain = true; } // telemetry-exempt: retained for the tip
  }
  if (!store) {
    try {
      if ((await fsp.readdir(getBaseDirPath())).some((name) => name.startsWith('projects.json.corrupt-'))) uncertain = true;
    } catch (err) {
      // telemetry-exempt: retain uncertainty when quarantine evidence cannot be read.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') uncertain = true;
    }
    appLog('core:project-store', 'info', 'No project store found on disk, starting with empty list', {
      meta: { storePath, backupPath },
    });
    chatTipProjectReadUncertain ||= uncertain;
    return { version: CURRENT_VERSION, projects: [] };
  }

  chatTipProjectReadUncertain ||= uncertain;
  return store;
}

async function writeStore(store: ProjectStoreV1): Promise<void> {
  return registryMutation(() => writeStoreInner(store));
}
async function writeStoreInner(store: ProjectStoreV1): Promise<void> {
  const storePath = await getStorePath();
  const backupPath = await getBackupPath();

  // Back up existing projects.json before overwriting — the backup preserves
  // the last known-good state so that a crash mid-write or corrupt write
  // can be auto-recovered on the next read. Only a fully valid primary is
  // rotated, so invalid data can never clobber a healthy backup.
  if (await pathExists(storePath) && await isRotatableStore(storePath)) {
    try {
      await fsp.copyFile(storePath, backupPath);
    } catch {
      // Non-fatal — best-effort backup
    }
  }

  // Atomic write: write to temp file then rename — prevents partial/corrupt
  // files if the process crashes mid-write.
  const tmpPath = storePath + '.tmp.' + randomUUID().slice(0, 8);
  await persist.timed('projects', async () => {
    await fsp.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    await fsp.rename(tmpPath, storePath);
  });

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

type ProjectsChangeListener = () => void;
const projectsChangeListeners = new Set<ProjectsChangeListener>();

/**
 * Listen for changes to the project list: a project added, removed, renamed
 * or otherwise updated. Listeners run synchronously after the write and may
 * be called for changes they don't care about. Returns an unsubscribe function.
 */
export function onProjectsChanged(listener: ProjectsChangeListener): () => void {
  projectsChangeListeners.add(listener);
  return () => { projectsChangeListeners.delete(listener); };
}

function notifyProjectsChanged(): void {
  for (const listener of projectsChangeListeners) {
    try {
      listener();
    } catch (err) {
      // telemetry-exempt: logged; a listener's failure must not fail the project write
      appLog('core:project-store', 'warn', 'Project change listener failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  }
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
    // The same list back means nothing changed (an add of a folder already registered).
    if (updated === projects) return updated;
    await writeProjects(updated);
    notifyProjectsChanged();
    return updated;
  };

  return registryMutation(() => {
    const next = projectUpdateQueue.then(run, run);
    projectUpdateQueue = next.then((): void => undefined, (): void => undefined);
    return next;
  });
}

export async function list(): Promise<Project[]> {
  return readProjects();
}

/**
 * The projects, for reads that must change nothing (#2653). list() can migrate
 * the store, quarantine a corrupt file and restore the backup; this only parses.
 */
export async function peekProjects(): Promise<Project[]> {
  // Not getStorePath: that creates the folder.
  for (const name of ['projects.json', 'projects.json.bak']) {
    try {
      const file = path.join(getBaseDirPath(), name);
      return migrate(JSON.parse(await fsp.readFile(file, 'utf-8'))).store.projects;
    } catch {
      // telemetry-exempt: a read that changes nothing; list() reports the corruption and recovers
    }
  }
  return [];
}

/**
 * peekProjects, also saying whether the list could be read (D99): not when
 * projects.json or its backup is there but neither reads and parses. With
 * neither file there are no projects. Changes nothing.
 */
export async function peekProjectsChecked(): Promise<{ projects: Project[]; readable: boolean }> {
  let present = false;
  for (const name of ['projects.json', 'projects.json.bak']) {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(getBaseDirPath(), name), 'utf-8');
    } catch (err) {
      // telemetry-exempt: no file is no projects; any other error means it couldn't be read, which the caller is told
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') present = true;
      continue;
    }
    present = true;
    try {
      return { projects: migrate(JSON.parse(raw)).store.projects, readable: true };
    } catch {
      // telemetry-exempt: a file that doesn't parse; the caller is told it couldn't be read
    }
  }
  return { projects: [], readable: !present };
}

/** What {@link addProject} did: the project, and whether this call created it. */
export interface AddProjectResult {
  project: Project;
  /** False when the folder was already registered and its project is returned. */
  created: boolean;
}

/** The registered project for a folder, by canonical path (#3236), or undefined. */
export async function findByPath(dirPath: string): Promise<Project | undefined> {
  return findByCanonicalPath(await readProjects(), dirPath);
}

/**
 * Register a folder as a project, or return the project it already is (#3236).
 * The check and the write share the registry's queue, so two adds of one
 * folder at once make one project.
 */
export async function addProject(dirPath: string): Promise<AddProjectResult> {
  let result: AddProjectResult | undefined;
  await updateProjects(async (projects) => {
    const existing = await findByCanonicalPath(projects, dirPath);
    if (existing) {
      result = { project: existing, created: false };
      return projects;
    }
    const project = await newProject(dirPath);
    result = { project, created: true };
    return [...projects, project];
  });
  const { project, created } = result!;
  if (created) {
    publishAppEvent({ type: 'project.added', projectId: project.id, projectPath: project.path });
  } else {
    appLog('core:project-store', 'info', 'Folder is already a project; returning it', {
      meta: { projectId: project.id },
    });
  }
  return result!;
}

/** Register a folder as a project, or return the project it already is. */
export async function add(dirPath: string): Promise<Project> {
  return (await addProject(dirPath)).project;
}

async function newProject(dirPath: string): Promise<Project> {
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
  return project;
}

export async function remove(id: string): Promise<void> {
  let removed: Project | undefined;
  await updateProjects(async (projects: Project[]): Promise<Project[]> => {
    const removedProject = projects.find((p) => p.id === id);
    removed = removedProject;

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
  if (removed) publishAppEvent({ type: 'project.removed', projectId: removed.id, projectPath: removed.path });
}

/** What the audit keeps of a project's own settings (#2671). A name is free text. */
const PROJECT_AUDIT_CATALOG: Readonly<Record<string, AuditKeyFormat>> = { color: 'value', orchestrator: 'value', name: 'changed', displayName: 'changed', emoji: 'changed', icon: 'changed' };

export async function update(id: string, updates: Partial<Pick<Project, 'color' | 'icon' | 'emoji' | 'name' | 'displayName' | 'orchestrator'>>): Promise<Project[]> {
  // Determine whether the icon file should be deleted before touching projects.json.
  // Deleting first avoids orphaned files if the process crashes between the JSON
  // write and the filesystem unlink (icon cleared from JSON but file never removed).
  const willClearIcon = updates.icon === '' || (updates.emoji !== undefined && updates.emoji !== '');
  if (willClearIcon) {
    await removeIconFile(id);
  }

  let auditBefore: Project | undefined;
  let auditAfter: Project | undefined;
  const updated = await updateProjects((projects) => {
    return projects.map((p) => {
      if (p.id !== id) return p;
      auditBefore = p;

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

      auditAfter = next;
      return next;
    });
  });
  if (auditBefore && auditAfter) {
    await auditChanges('project', 'project', id, auditBefore as unknown as Record<string, unknown>, auditAfter as unknown as Record<string, unknown>, PROJECT_AUDIT_CATALOG);
  }
  return updated;
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

export async function removeIconFile(projectId: string, keep?: string): Promise<void> {
  const iconsDir = await getIconsDir();
  try {
    const files = await fsp.readdir(iconsDir);
    for (const file of files) {
      if (file.startsWith(projectId + '.') && file !== keep) {
        await fsp.unlink(path.join(iconsDir, file));
      }
    }
  } catch {
    // icons dir may not exist yet
  }
}

/** Where a project icon file is, or null for a name outside the icons folder. */
export async function iconFilePath(filename: string): Promise<string | null> {
  const iconsDir = await getIconsDir();
  const filePath = path.resolve(iconsDir, filename);
  return filePath.startsWith(iconsDir + path.sep) ? filePath : null;
}

export async function readIconData(filename: string): Promise<string | null> {
  const filePath = await iconFilePath(filename);
  if (!filePath || !await pathExists(filePath)) return null;

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

/**
 * Store an image as the project's icon file and drop its old one. Returns the
 * filename for `update` to record. The name follows the content, so a window
 * can tell a new image from the old without reading it.
 */
export async function writeIconFile(projectId: string, bytes: Uint8Array, extension: string): Promise<string> {
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
  const filename = `${projectId}.${hash}.${extension}`;
  const iconsDir = await getIconsDir();
  await fsp.writeFile(path.join(iconsDir, filename), bytes);
  await removeIconFile(projectId, filename);
  return filename;
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
