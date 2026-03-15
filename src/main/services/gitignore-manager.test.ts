import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

import * as fsp from 'fs/promises';
import { addEntries, removeEntries, isIgnored } from './gitignore-manager';

const PROJECT = path.join(path.sep, 'projects', 'test-project');
const GITIGNORE = path.join(PROJECT, '.gitignore');

describe('gitignore-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addEntries', () => {
    it('creates .gitignore with tagged entries when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await addEntries(PROJECT, 'my-plugin', ['dist/', '.cache/']);
      expect(fsp.writeFile).toHaveBeenCalledWith(
        GITIGNORE,
        'dist/ # clubhouse-plugin: my-plugin\n.cache/ # clubhouse-plugin: my-plugin\n',
        'utf-8',
      );
    });

    it('appends tagged entries to existing .gitignore', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('node_modules/\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await addEntries(PROJECT, 'my-plugin', ['dist/']);
      expect(fsp.writeFile).toHaveBeenCalledWith(
        GITIGNORE,
        'node_modules/\ndist/ # clubhouse-plugin: my-plugin\n',
        'utf-8',
      );
    });

    it('adds newline separator when existing file does not end with newline', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('node_modules/');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await addEntries(PROJECT, 'my-plugin', ['dist/']);
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toBe('node_modules/\ndist/ # clubhouse-plugin: my-plugin\n');
    });

    it('does not duplicate entries that already exist', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('dist/ # clubhouse-plugin: my-plugin\n');
      await addEntries(PROJECT, 'my-plugin', ['dist/']);
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('adds multiple entries at once', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await addEntries(PROJECT, 'test', ['a/', 'b/', 'c/']);
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      const lines = written.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('a/ # clubhouse-plugin: test');
    });

    it('isolates entries by plugin id', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('dist/ # clubhouse-plugin: plugin-a\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await addEntries(PROJECT, 'plugin-b', ['dist/']);
      expect(fsp.writeFile).toHaveBeenCalled();
    });
  });

  describe('removeEntries', () => {
    it('removes all lines tagged for the specified plugin', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        'node_modules/\ndist/ # clubhouse-plugin: my-plugin\n.cache/ # clubhouse-plugin: my-plugin\n',
      );
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await removeEntries(PROJECT, 'my-plugin');
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toBe('node_modules/\n');
      expect(written).not.toContain('clubhouse-plugin: my-plugin');
    });

    it('does not affect entries from other plugins', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        'dist/ # clubhouse-plugin: plugin-a\nout/ # clubhouse-plugin: plugin-b\n',
      );
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await removeEntries(PROJECT, 'plugin-a');
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('clubhouse-plugin: plugin-b');
      expect(written).not.toContain('clubhouse-plugin: plugin-a');
    });

    it('does nothing when .gitignore does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      await removeEntries(PROJECT, 'my-plugin');
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('removes trailing blank lines left behind', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('dist/ # clubhouse-plugin: my-plugin\n\n\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      await removeEntries(PROJECT, 'my-plugin');
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toBe('');
    });
  });

  describe('isIgnored', () => {
    it('returns true when pattern is in .gitignore', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('node_modules/\ndist/ # clubhouse-plugin: test\n');
      expect(await isIgnored(PROJECT, 'dist/')).toBe(true);
    });

    it('returns true for untagged patterns', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('node_modules/\n');
      expect(await isIgnored(PROJECT, 'node_modules/')).toBe(true);
    });

    it('returns false when pattern is not found', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('node_modules/\n');
      expect(await isIgnored(PROJECT, 'dist/')).toBe(false);
    });

    it('returns false when .gitignore does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await isIgnored(PROJECT, 'anything')).toBe(false);
    });
  });
});
