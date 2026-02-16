import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Project } from '../../shared/types';

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
      writeStore(store);
    }
    return store;
  } catch {
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
  projects.push(project);
  writeProjects(projects);
  return project;
}

export function remove(id: string): void {
  const projects = readProjects();
  const filtered = projects.filter((p) => p.id !== id);
  writeProjects(filtered);
  removeIconFile(id);
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
