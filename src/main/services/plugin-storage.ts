import * as fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type {
  PluginStorageReadRequest,
  PluginStorageWriteRequest,
  PluginStorageDeleteRequest,
  PluginStorageListRequest,
  PluginFileRequest,
} from '../../shared/plugin-types';
import { appLog } from './log-service';

// Track which projects have already had .gitignore updated this session
const gitignoreEnsured = new Set<string>();

async function ensurePluginDataLocalGitignored(projectPath: string): Promise<void> {
  if (gitignoreEnsured.has(projectPath)) return;
  gitignoreEnsured.add(projectPath);

  const pattern = '.clubhouse/plugin-data-local/';
  const gitignorePath = path.join(projectPath, '.gitignore');

  try {
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // File doesn't exist yet
    }
    if (content.includes(pattern)) return;
    const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
    await fs.writeFile(gitignorePath, content + separator + pattern + '\n', 'utf-8');
  } catch {
    // Best-effort — don't break storage if .gitignore can't be written
  }
}

function getGlobalPluginDataDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugin-data');
}

function getStorageDir(pluginId: string, scope: 'project' | 'project-local' | 'global', projectPath?: string): string {
  if (scope === 'project' && projectPath) {
    return path.join(projectPath, '.clubhouse', 'plugin-data', pluginId);
  }
  if (scope === 'project-local' && projectPath) {
    return path.join(projectPath, '.clubhouse', 'plugin-data-local', pluginId);
  }
  return path.join(getGlobalPluginDataDir(), pluginId);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function assertSafePath(base: string, target: string): void {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(resolvedBase)) {
    appLog('core:plugin-storage', 'error', 'Path traversal attempt blocked', {
      meta: { base, target, resolved },
    });
    throw new Error(`Path traversal detected: ${target}`);
  }
}

// ── Key-Value Storage ──────────────────────────────────────────────────

export async function readKey(req: PluginStorageReadRequest): Promise<unknown> {
  const dir = path.join(getStorageDir(req.pluginId, req.scope, req.projectPath), 'kv');
  const file = path.join(dir, `${req.key}.json`);
  assertSafePath(dir, `${req.key}.json`);
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export async function writeKey(req: PluginStorageWriteRequest): Promise<void> {
  if (req.scope === 'project-local' && req.projectPath) {
    await ensurePluginDataLocalGitignored(req.projectPath);
  }
  const dir = path.join(getStorageDir(req.pluginId, req.scope, req.projectPath), 'kv');
  assertSafePath(dir, `${req.key}.json`);
  await ensureDir(dir);
  const file = path.join(dir, `${req.key}.json`);
  await fs.writeFile(file, JSON.stringify(req.value), 'utf-8');
}

export async function deleteKey(req: PluginStorageDeleteRequest): Promise<void> {
  const dir = path.join(getStorageDir(req.pluginId, req.scope, req.projectPath), 'kv');
  const file = path.join(dir, `${req.key}.json`);
  assertSafePath(dir, `${req.key}.json`);
  try {
    await fs.unlink(file);
  } catch {
    // File doesn't exist, that's fine
  }
}

export async function listKeys(req: PluginStorageListRequest): Promise<string[]> {
  const dir = path.join(getStorageDir(req.pluginId, req.scope, req.projectPath), 'kv');
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ── Raw File Operations ────────────────────────────────────────────────

export async function readPluginFile(req: PluginFileRequest): Promise<string> {
  const base = getStorageDir(req.pluginId, req.scope, req.projectPath);
  assertSafePath(base, req.relativePath);
  const filePath = path.join(base, req.relativePath);
  return fs.readFile(filePath, 'utf-8');
}

export async function writePluginFile(req: PluginFileRequest & { content: string }): Promise<void> {
  const base = getStorageDir(req.pluginId, req.scope, req.projectPath);
  assertSafePath(base, req.relativePath);
  const filePath = path.join(base, req.relativePath);
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, req.content, 'utf-8');
}

export async function deletePluginFile(req: PluginFileRequest): Promise<void> {
  const base = getStorageDir(req.pluginId, req.scope, req.projectPath);
  assertSafePath(base, req.relativePath);
  const filePath = path.join(base, req.relativePath);
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist
  }
}

export async function pluginFileExists(req: PluginFileRequest): Promise<boolean> {
  const base = getStorageDir(req.pluginId, req.scope, req.projectPath);
  assertSafePath(base, req.relativePath);
  const filePath = path.join(base, req.relativePath);
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function listPluginDir(req: PluginFileRequest): Promise<Array<{ name: string; isDirectory: boolean }>> {
  const base = getStorageDir(req.pluginId, req.scope, req.projectPath);
  assertSafePath(base, req.relativePath);
  const dirPath = path.join(base, req.relativePath);
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return [];
  }
}

export async function mkdirPlugin(pluginId: string, scope: 'project' | 'global', relativePath: string, projectPath?: string): Promise<void> {
  const base = getStorageDir(pluginId, scope, projectPath);
  assertSafePath(base, relativePath);
  const dirPath = path.join(base, relativePath);
  await ensureDir(dirPath);
}
