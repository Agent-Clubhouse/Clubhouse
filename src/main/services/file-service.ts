import * as fs from 'fs';
import * as path from 'path';
import { FileNode } from '../../shared/types';

const IGNORED = new Set([
  'node_modules', '.git', '.DS_Store', '.webpack', 'dist', '.next', '__pycache__',
]);

export function readTree(dirPath: string, depth = 10): FileNode[] {
  if (depth <= 0) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
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
          node.children = readTree(fullPath, depth - 1);
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
