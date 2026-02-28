import * as fs from 'fs/promises';
import * as path from 'path';
import { FileNode } from '../../shared/types';

const IGNORED = new Set([
  'node_modules', '.git', '.DS_Store', '.webpack', 'dist', '.next', '__pycache__',
]);

export interface ReadTreeOptions {
  includeHidden?: boolean;
  depth?: number;
  /** Maximum total file/directory nodes to return. Limits traversal on large repos. */
  maxFiles?: number;
  /** AbortSignal to cancel an in-progress tree read. */
  signal?: AbortSignal;
}

interface ReadTreeState {
  count: number;
  maxFiles: number;
  signal?: AbortSignal;
}

async function readTreeInternal(
  dirPath: string,
  includeHidden: boolean,
  depth: number,
  state: ReadTreeState,
): Promise<FileNode[]> {
  if (depth <= 0 || state.count >= state.maxFiles) return [];
  if (state.signal?.aborted) return [];

  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const filtered = entries
      .filter((e) => !IGNORED.has(e.name) && (includeHidden || !e.name.startsWith('.')))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    const results: FileNode[] = [];
    for (const e of filtered) {
      if (state.count >= state.maxFiles) break;
      if (state.signal?.aborted) break;

      state.count++;
      const fullPath = path.join(dirPath, e.name);
      const node: FileNode = {
        name: e.name,
        path: fullPath,
        isDirectory: e.isDirectory(),
      };
      if (e.isDirectory()) {
        node.children = await readTreeInternal(fullPath, includeHidden, depth - 1, state);
      }
      results.push(node);
    }
    return results;
  } catch {
    return [];
  }
}

const DEFAULT_MAX_FILES = 10_000;

export async function readTree(dirPath: string, options?: ReadTreeOptions): Promise<FileNode[]> {
  const depth = options?.depth ?? 10;
  const includeHidden = options?.includeHidden ?? false;
  const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  const state: ReadTreeState = { count: 0, maxFiles, signal: options?.signal };
  return readTreeInternal(dirPath, includeHidden, depth, state);
}

export async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8');
}

export async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.writeFile(filePath, content, 'utf-8');
}

export async function mkdir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function deleteFile(filePath: string): Promise<void> {
  await fs.rm(filePath, { recursive: true, force: true });
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  await fs.rename(oldPath, newPath);
}

export async function copy(src: string, dest: string): Promise<void> {
  await fs.cp(src, dest, { recursive: true });
}

export interface FileStatResult {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: number;
}

export async function stat(filePath: string): Promise<FileStatResult> {
  const s = await fs.stat(filePath);
  return {
    size: s.size,
    isDirectory: s.isDirectory(),
    isFile: s.isFile(),
    modifiedAt: s.mtimeMs,
  };
}

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
};

export async function readBinary(filePath: string): Promise<string> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const data = await fs.readFile(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}
