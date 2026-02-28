import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readTree, rename, copy, stat, readFile, writeFile, mkdir, deleteFile, readBinary } from './file-service';

describe('file-service', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-service-test-'));

    // Create a test file tree:
    // tmpDir/
    //   visible-file.ts
    //   .hidden-file
    //   sub-dir/
    //     nested.ts
    //   .hidden-dir/
    //     secret.txt
    fs.writeFileSync(path.join(tmpDir, 'visible-file.ts'), 'export {};');
    fs.writeFileSync(path.join(tmpDir, '.hidden-file'), 'secret');
    fs.mkdirSync(path.join(tmpDir, 'sub-dir'));
    fs.writeFileSync(path.join(tmpDir, 'sub-dir', 'nested.ts'), 'const x = 1;');
    fs.mkdirSync(path.join(tmpDir, '.hidden-dir'));
    fs.writeFileSync(path.join(tmpDir, '.hidden-dir', 'secret.txt'), 'data');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readTree', () => {
    it('excludes hidden files by default', async () => {
      const tree = await readTree(tmpDir);
      const names = tree.map((n) => n.name);
      expect(names).toContain('visible-file.ts');
      expect(names).toContain('sub-dir');
      expect(names).not.toContain('.hidden-file');
      expect(names).not.toContain('.hidden-dir');
    });

    it('includes hidden files when includeHidden is true', async () => {
      const tree = await readTree(tmpDir, { includeHidden: true });
      const names = tree.map((n) => n.name);
      expect(names).toContain('visible-file.ts');
      expect(names).toContain('.hidden-file');
      expect(names).toContain('.hidden-dir');
    });

    it('respects depth: 1 — only immediate children', async () => {
      const tree = await readTree(tmpDir, { depth: 1 });
      const subDir = tree.find((n) => n.name === 'sub-dir');
      expect(subDir).toBeDefined();
      // With depth: 1, the sub-dir itself should have children loaded (depth 0 stops)
      // but its children won't recurse further
      expect(subDir!.children).toBeDefined();
    });

    it('sorts directories before files', async () => {
      const tree = await readTree(tmpDir);
      const dirIndex = tree.findIndex((n) => n.name === 'sub-dir');
      const fileIndex = tree.findIndex((n) => n.name === 'visible-file.ts');
      expect(dirIndex).toBeLessThan(fileIndex);
    });

    it('returns empty array for non-existent directory', async () => {
      const tree = await readTree(path.join(tmpDir, 'nonexistent'));
      expect(tree).toEqual([]);
    });

    it('respects maxFiles limit', async () => {
      // Create many files
      for (let i = 0; i < 20; i++) {
        fs.writeFileSync(path.join(tmpDir, `file-${i}.txt`), `content ${i}`);
      }
      const tree = await readTree(tmpDir, { maxFiles: 5 });
      // Count total nodes (flatten tree)
      function countNodes(nodes: { children?: any[] }[]): number {
        let count = 0;
        for (const n of nodes) {
          count++;
          if (n.children) count += countNodes(n.children);
        }
        return count;
      }
      expect(countNodes(tree)).toBeLessThanOrEqual(5);
    });

    it('respects abort signal', async () => {
      const controller = new AbortController();
      controller.abort();
      const tree = await readTree(tmpDir, { signal: controller.signal });
      expect(tree).toEqual([]);
    });
  });

  describe('readFile', () => {
    it('reads file content as utf-8', async () => {
      const content = await readFile(path.join(tmpDir, 'visible-file.ts'));
      expect(content).toBe('export {};');
    });

    it('rejects for non-existent file', async () => {
      await expect(readFile(path.join(tmpDir, 'nope.txt'))).rejects.toThrow();
    });
  });

  describe('writeFile', () => {
    it('writes content to file', async () => {
      const filePath = path.join(tmpDir, 'new-file.txt');
      await writeFile(filePath, 'hello world');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello world');
    });
  });

  describe('mkdir', () => {
    it('creates directory recursively', async () => {
      const dirPath = path.join(tmpDir, 'a', 'b', 'c');
      await mkdir(dirPath);
      expect(fs.existsSync(dirPath)).toBe(true);
    });
  });

  describe('deleteFile', () => {
    it('deletes a file', async () => {
      const filePath = path.join(tmpDir, 'visible-file.ts');
      await deleteFile(filePath);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('deletes a directory recursively', async () => {
      await deleteFile(path.join(tmpDir, 'sub-dir'));
      expect(fs.existsSync(path.join(tmpDir, 'sub-dir'))).toBe(false);
    });
  });

  describe('rename', () => {
    it('renames a file', async () => {
      const oldPath = path.join(tmpDir, 'visible-file.ts');
      const newPath = path.join(tmpDir, 'renamed.ts');
      await rename(oldPath, newPath);
      expect(fs.existsSync(newPath)).toBe(true);
      expect(fs.existsSync(oldPath)).toBe(false);
    });

    it('rejects when source does not exist', async () => {
      await expect(rename(
        path.join(tmpDir, 'nope.txt'),
        path.join(tmpDir, 'dest.txt'),
      )).rejects.toThrow();
    });
  });

  describe('copy', () => {
    it('copies a file', async () => {
      const src = path.join(tmpDir, 'visible-file.ts');
      const dest = path.join(tmpDir, 'copy.ts');
      await copy(src, dest);
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toBe('export {};');
    });

    it('copies a directory recursively', async () => {
      const src = path.join(tmpDir, 'sub-dir');
      const dest = path.join(tmpDir, 'sub-dir-copy');
      await copy(src, dest);
      expect(fs.existsSync(path.join(dest, 'nested.ts'))).toBe(true);
    });
  });

  describe('stat', () => {
    it('returns stat info for a file', async () => {
      const result = await stat(path.join(tmpDir, 'visible-file.ts'));
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
      expect(result.size).toBeGreaterThan(0);
      expect(result.modifiedAt).toBeGreaterThan(0);
    });

    it('returns stat info for a directory', async () => {
      const result = await stat(path.join(tmpDir, 'sub-dir'));
      expect(result.isFile).toBe(false);
      expect(result.isDirectory).toBe(true);
    });

    it('rejects when file does not exist', async () => {
      await expect(stat(path.join(tmpDir, 'nonexistent'))).rejects.toThrow();
    });
  });

  describe('readBinary', () => {
    it('reads a binary file as base64 data URI', async () => {
      const pngPath = path.join(tmpDir, 'test.png');
      fs.writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const result = await readBinary(pngPath);
      expect(result).toMatch(/^data:image\/png;base64,/);
    });
  });
});
