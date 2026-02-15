import * as fs from 'fs';
import * as path from 'path';
import { FileNode } from '../../shared/types';

const IGNORED = new Set([
  'node_modules', '.git', '.DS_Store', '.webpack', 'dist', '.next', '__pycache__',
]);

export interface ReadTreeOptions {
  includeHidden?: boolean;
  depth?: number;
}

export function readTree(dirPath: string, options?: ReadTreeOptions): FileNode[] {
  const depth = options?.depth ?? 10;
  const includeHidden = options?.includeHidden ?? false;
  if (depth <= 0) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !IGNORED.has(e.name) && (includeHidden || !e.name.startsWith('.')))
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => {
        const fullPath = path.join(dirPath, e.name);
        const node: FileNode = {
          name: e.name,
          path: fullPath,
          isDirectory: e.isDirectory(),
        };
        if (e.isDirectory()) {
          node.children = readTree(fullPath, { includeHidden, depth: depth - 1 });
        }
        return node;
      });
  } catch {
    return [];
  }
}

export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function mkdir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function deleteFile(filePath: string): void {
  fs.rmSync(filePath, { recursive: true, force: true });
}

export function rename(oldPath: string, newPath: string): void {
  fs.renameSync(oldPath, newPath);
}

export function copy(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true });
}

export interface FileStatResult {
  size: number;
  isDirectory: boolean;
  isFile: boolean;
  modifiedAt: number;
}

export function stat(filePath: string): FileStatResult {
  const s = fs.statSync(filePath);
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

export function readBinary(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const data = fs.readFileSync(filePath);
  return `data:${mime};base64,${data.toString('base64')}`;
}
