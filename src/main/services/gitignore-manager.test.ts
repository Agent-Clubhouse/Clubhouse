import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import * as fs from 'fs';
import { addEntries, removeEntries, isIgnored } from './gitignore-manager';

const PROJECT = path.join(path.sep, 'projects', 'test-project');
const GITIGNORE = path.join(PROJECT, '.gitignore');

describe('gitignore-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addEntries', () => {
    it('creates .gitignore with tagged entries when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      addEntries(PROJECT, 'my-plugin', ['dist/', '.cache/']);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        GITIGNORE,
        'dist/ # clubhouse-plugin: my-plugin\n.cache/ # clubhouse-plugin: my-plugin\n',
        'utf-8',
      );
    });

    it('appends tagged entries to existing .gitignore', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/\n');
      addEntries(PROJECT, 'my-plugin', ['dist/']);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        GITIGNORE,
        'node_modules/\ndist/ # clubhouse-plugin: my-plugin\n',
        'utf-8',
      );
    });

    it('adds newline separator when existing file does not end with newline', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/');
      addEntries(PROJECT, 'my-plugin', ['dist/']);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe('node_modules/\ndist/ # clubhouse-plugin: my-plugin\n');
    });

    it('does not duplicate entries that already exist', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('dist/ # clubhouse-plugin: my-plugin\n');
      addEntries(PROJECT, 'my-plugin', ['dist/']);
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('adds multiple entries at once', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      addEntries(PROJECT, 'test', ['a/', 'b/', 'c/']);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('a/ # clubhouse-plugin: test');
    });

    it('isolates entries by plugin id', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('dist/ # clubhouse-plugin: plugin-a\n');
      addEntries(PROJECT, 'plugin-b', ['dist/']);
      // Should add because the tag is different
      expect(fs.writeFileSync).toHaveBeenCalled();
    });
  });

  describe('removeEntries', () => {
    it('removes all lines tagged for the specified plugin', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        'node_modules/\ndist/ # clubhouse-plugin: my-plugin\n.cache/ # clubhouse-plugin: my-plugin\n',
      );
      removeEntries(PROJECT, 'my-plugin');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe('node_modules/\n');
      expect(written).not.toContain('clubhouse-plugin: my-plugin');
    });

    it('does not affect entries from other plugins', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        'dist/ # clubhouse-plugin: plugin-a\nout/ # clubhouse-plugin: plugin-b\n',
      );
      removeEntries(PROJECT, 'plugin-a');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('clubhouse-plugin: plugin-b');
      expect(written).not.toContain('clubhouse-plugin: plugin-a');
    });

    it('does nothing when .gitignore does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      removeEntries(PROJECT, 'my-plugin');
      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('removes trailing blank lines left behind', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('dist/ # clubhouse-plugin: my-plugin\n\n\n');
      removeEntries(PROJECT, 'my-plugin');
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe('');
    });
  });

  describe('isIgnored', () => {
    it('returns true when pattern is in .gitignore', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/\ndist/ # clubhouse-plugin: test\n');
      expect(isIgnored(PROJECT, 'dist/')).toBe(true);
    });

    it('returns true for untagged patterns', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/\n');
      expect(isIgnored(PROJECT, 'node_modules/')).toBe(true);
    });

    it('returns false when pattern is not found', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('node_modules/\n');
      expect(isIgnored(PROJECT, 'dist/')).toBe(false);
    });

    it('returns false when .gitignore does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(isIgnored(PROJECT, 'anything')).toBe(false);
    });
  });
});
