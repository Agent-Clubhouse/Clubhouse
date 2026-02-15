import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readTree, rename, copy, stat } from './file-service';

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
    it('excludes hidden files by default', () => {
      const tree = readTree(tmpDir);
      const names = tree.map((n) => n.name);
      expect(names).toContain('visible-file.ts');
      expect(names).toContain('sub-dir');
      expect(names).not.toContain('.hidden-file');
      expect(names).not.toContain('.hidden-dir');
    });

    it('includes hidden files when includeHidden is true', () => {
      const tree = readTree(tmpDir, { includeHidden: true });
      const names = tree.map((n) => n.name);
      expect(names).toContain('visible-file.ts');
      expect(names).toContain('.hidden-file');
      expect(names).toContain('.hidden-dir');
    });

    it('respects depth: 1 — only immediate children', () => {
      const tree = readTree(tmpDir, { depth: 1 });
      const subDir = tree.find((n) => n.name === 'sub-dir');
      expect(subDir).toBeDefined();
      // With depth: 1, the sub-dir itself should have children loaded (depth 0 stops)
      // but its children won't recurse further
      expect(subDir!.children).toBeDefined();
    });

    it('sorts directories before files', () => {
      const tree = readTree(tmpDir);
      const dirIndex = tree.findIndex((n) => n.name === 'sub-dir');
      const fileIndex = tree.findIndex((n) => n.name === 'visible-file.ts');
      expect(dirIndex).toBeLessThan(fileIndex);
    });

    it('returns empty array for non-existent directory', () => {
      const tree = readTree(path.join(tmpDir, 'nonexistent'));
      expect(tree).toEqual([]);
    });
  });

  describe('rename', () => {
    it('renames a file', () => {
      const oldPath = path.join(tmpDir, 'visible-file.ts');
      const newPath = path.join(tmpDir, 'renamed.ts');
      rename(oldPath, newPath);
      expect(fs.existsSync(newPath)).toBe(true);
      expect(fs.existsSync(oldPath)).toBe(false);
    });

    it('throws when source does not exist', () => {
      expect(() => rename(
        path.join(tmpDir, 'nope.txt'),
        path.join(tmpDir, 'dest.txt'),
      )).toThrow();
    });
  });

  describe('copy', () => {
    it('copies a file', () => {
      const src = path.join(tmpDir, 'visible-file.ts');
      const dest = path.join(tmpDir, 'copy.ts');
      copy(src, dest);
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.readFileSync(dest, 'utf-8')).toBe('export {};');
    });

    it('copies a directory recursively', () => {
      const src = path.join(tmpDir, 'sub-dir');
      const dest = path.join(tmpDir, 'sub-dir-copy');
      copy(src, dest);
      expect(fs.existsSync(path.join(dest, 'nested.ts'))).toBe(true);
    });
  });

  describe('stat', () => {
    it('returns stat info for a file', () => {
      const result = stat(path.join(tmpDir, 'visible-file.ts'));
      expect(result.isFile).toBe(true);
      expect(result.isDirectory).toBe(false);
      expect(result.size).toBeGreaterThan(0);
      expect(result.modifiedAt).toBeGreaterThan(0);
    });

    it('returns stat info for a directory', () => {
      const result = stat(path.join(tmpDir, 'sub-dir'));
      expect(result.isFile).toBe(false);
      expect(result.isDirectory).toBe(true);
    });

    it('throws when file does not exist', () => {
      expect(() => stat(path.join(tmpDir, 'nonexistent'))).toThrow();
    });
  });
});
