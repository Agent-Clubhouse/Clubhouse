import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
  rm: vi.fn(),
}));

import * as fsp from 'fs/promises';
import {
  readKey,
  writeKey,
  deleteKey,
  listKeys,
  readPluginFile,
  writePluginFile,
  deletePluginFile,
  pluginFileExists,
  listPluginDir,
  mkdirPlugin,
} from './plugin-storage';

// electron mock provides app.getPath('home') → path.join(os.tmpdir(), 'clubhouse-test-home')
const GLOBAL_BASE = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'plugin-data');

describe('plugin-storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Key-Value Storage ───────────────────────────────────────────────

  describe('readKey', () => {
    it('reads and parses JSON from kv directory', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ hello: 'world' }));
      const result = await readKey({ pluginId: 'my-plugin', scope: 'global', key: 'config' });
      expect(result).toEqual({ hello: 'world' });
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'config.json'),
        'utf-8',
      );
    });

    it('returns undefined when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await readKey({ pluginId: 'my-plugin', scope: 'global', key: 'missing' });
      expect(result).toBeUndefined();
    });

    it('uses project-scoped path when scope is project', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('"value"');
      const projectPath = path.join(path.sep, 'projects', 'foo');
      await readKey({ pluginId: 'my-plugin', scope: 'project', key: 'data', projectPath });
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data', 'my-plugin', 'kv', 'data.json'),
        'utf-8',
      );
    });

    it('rejects path traversal attempts', async () => {
      await expect(
        readKey({ pluginId: 'my-plugin', scope: 'global', key: '../../etc/passwd' }),
      ).rejects.toThrow('Path traversal');
    });
  });

  describe('writeKey', () => {
    it('writes JSON to kv directory and ensures dir exists', async () => {
      await writeKey({ pluginId: 'my-plugin', scope: 'global', key: 'config', value: { a: 1 } });
      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv'),
        { recursive: true },
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'config.json'),
        JSON.stringify({ a: 1 }),
        'utf-8',
      );
    });

    it('rejects path traversal in key', async () => {
      await expect(
        writeKey({ pluginId: 'p', scope: 'global', key: '../../../evil', value: 'x' }),
      ).rejects.toThrow('Path traversal');
    });
  });

  describe('deleteKey', () => {
    it('unlinks the key file', async () => {
      await deleteKey({ pluginId: 'my-plugin', scope: 'global', key: 'old' });
      expect(fsp.unlink).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'old.json'),
      );
    });

    it('does not throw when file does not exist', async () => {
      vi.mocked(fsp.unlink).mockRejectedValue(new Error('ENOENT'));
      await expect(deleteKey({ pluginId: 'p', scope: 'global', key: 'missing' })).resolves.not.toThrow();
    });

    it('rejects path traversal in key', async () => {
      await expect(
        deleteKey({ pluginId: 'p', scope: 'global', key: '../../bad' }),
      ).rejects.toThrow('Path traversal');
    });
  });

  describe('listKeys', () => {
    it('returns key names without .json extension', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue(['config.json', 'state.json', 'readme.txt'] as any);
      const keys = await listKeys({ pluginId: 'my-plugin', scope: 'global' });
      expect(keys).toEqual(['config', 'state']);
    });

    it('returns empty array when directory does not exist', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
      const keys = await listKeys({ pluginId: 'my-plugin', scope: 'global' });
      expect(keys).toEqual([]);
    });
  });

  // ── Raw File Operations ─────────────────────────────────────────────

  describe('readPluginFile', () => {
    it('reads file at the resolved path', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('file content');
      const result = await readPluginFile({
        pluginId: 'p',
        scope: 'global',
        relativePath: 'data/notes.txt',
      });
      expect(result).toBe('file content');
    });

    it('rejects path traversal', async () => {
      await expect(
        readPluginFile({ pluginId: 'p', scope: 'global', relativePath: '../../secret' }),
      ).rejects.toThrow('Path traversal');
    });
  });

  describe('writePluginFile', () => {
    it('writes file and creates parent directories', async () => {
      await writePluginFile({
        pluginId: 'p',
        scope: 'global',
        relativePath: 'data/out.txt',
        content: 'hello',
      });
      expect(fsp.mkdir).toHaveBeenCalled();
      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('data', 'out.txt')),
        'hello',
        'utf-8',
      );
    });

    it('rejects path traversal', async () => {
      await expect(
        writePluginFile({ pluginId: 'p', scope: 'global', relativePath: '../bad', content: 'x' }),
      ).rejects.toThrow('Path traversal');
    });
  });

  describe('deletePluginFile', () => {
    it('unlinks the file', async () => {
      await deletePluginFile({ pluginId: 'p', scope: 'global', relativePath: 'old.txt' });
      expect(fsp.unlink).toHaveBeenCalled();
    });

    it('does not throw when file does not exist', async () => {
      vi.mocked(fsp.unlink).mockRejectedValue(new Error('ENOENT'));
      await expect(
        deletePluginFile({ pluginId: 'p', scope: 'global', relativePath: 'missing.txt' }),
      ).resolves.not.toThrow();
    });
  });

  describe('pluginFileExists', () => {
    it('returns true when file exists', async () => {
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      expect(await pluginFileExists({ pluginId: 'p', scope: 'global', relativePath: 'data.json' })).toBe(true);
    });

    it('returns false when file does not exist', async () => {
      vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));
      expect(await pluginFileExists({ pluginId: 'p', scope: 'global', relativePath: 'nope' })).toBe(false);
    });
  });

  describe('listPluginDir', () => {
    it('returns directory entries with isDirectory flag', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'sub', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ] as any);
      const entries = await listPluginDir({ pluginId: 'p', scope: 'global', relativePath: '.' });
      expect(entries).toEqual([
        { name: 'sub', isDirectory: true },
        { name: 'file.txt', isDirectory: false },
      ]);
    });

    it('returns empty array when directory does not exist', async () => {
      vi.mocked(fsp.readdir).mockRejectedValue(new Error('ENOENT'));
      expect(await listPluginDir({ pluginId: 'p', scope: 'global', relativePath: '.' })).toEqual([]);
    });
  });

  describe('mkdirPlugin', () => {
    it('creates directory recursively', async () => {
      await mkdirPlugin('p', 'global', 'sub/dir');
      expect(fsp.mkdir).toHaveBeenCalledWith(
        expect.stringContaining(path.join('sub', 'dir')),
        { recursive: true },
      );
    });

    it('rejects path traversal', async () => {
      await expect(mkdirPlugin('p', 'global', '../../escape')).rejects.toThrow('Path traversal');
    });
  });

  // ── project-local scope ──────────────────────────────────────────────

  describe('project-local scope', () => {
    const projectPath = path.join(path.sep, 'projects', 'foo');

    it('readKey uses plugin-data-local path', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('"value"');
      await readKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'data', projectPath });
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'data.json'),
        'utf-8',
      );
    });

    it('writeKey uses plugin-data-local path', async () => {
      // The gitignore ensurer will try to readFile for .gitignore - mock that too
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      await writeKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'config', value: 42, projectPath });
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'config.json'),
        '42',
        'utf-8',
      );
    });

    it('deleteKey uses plugin-data-local path', async () => {
      await deleteKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'old', projectPath });
      expect(fsp.unlink).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'old.json'),
      );
    });

    it('listKeys uses plugin-data-local path', async () => {
      vi.mocked(fsp.readdir).mockResolvedValue(['a.json'] as any);
      await listKeys({ pluginId: 'my-plugin', scope: 'project-local', projectPath });
      expect(fsp.readdir).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv'),
      );
    });

    it('rejects path traversal for project-local', async () => {
      await expect(
        readKey({ pluginId: 'p', scope: 'project-local', key: '../../etc/passwd', projectPath }),
      ).rejects.toThrow('Path traversal');
    });
  });

  // ── ensurePluginDataLocalGitignored ──────────────────────────────────

  describe('ensurePluginDataLocalGitignored', () => {
    it('only project-local writeKey triggers gitignore logic (not project or global)', async () => {
      await writeKey({ pluginId: 'p', scope: 'global', key: 'k', value: 'v' });
      // Global write should not touch .gitignore
      expect(fsp.readFile).not.toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        expect.any(String),
      );
    });
  });

  // ── ensurePluginDataLocalGitignored (isolated) ──────────────────────

  describe('ensurePluginDataLocalGitignored (fresh module)', () => {
    it('appends pattern when .gitignore exists without it', async () => {
      vi.resetModules();
      vi.mock('fs/promises', () => ({
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        unlink: vi.fn(),
        access: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      }));
      const freshFsp = await import('fs/promises');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFsp.readFile).mockImplementation((async (p: string) => {
        if (typeof p === 'string' && p.endsWith('.gitignore')) return 'node_modules/\n';
        return '""';
      }) as any);

      await freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'bar') });

      const gitignoreWrites = vi.mocked(freshFsp.writeFile).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(1);
      expect(gitignoreWrites[0][1]).toContain('.clubhouse/plugin-data-local/');
    });

    it('skips write if pattern already present', async () => {
      vi.resetModules();
      vi.mock('fs/promises', () => ({
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        unlink: vi.fn(),
        access: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      }));
      const freshFsp = await import('fs/promises');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFsp.readFile).mockImplementation((async (p: string) => {
        if (typeof p === 'string' && p.endsWith('.gitignore')) return '.clubhouse/plugin-data-local/\n';
        return '""';
      }) as any);

      await freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'bar') });

      const gitignoreWrites = vi.mocked(freshFsp.writeFile).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(0);
    });

    it('creates .gitignore file if missing', async () => {
      vi.resetModules();
      vi.mock('fs/promises', () => ({
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        unlink: vi.fn(),
        access: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      }));
      const freshFsp = await import('fs/promises');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'baz') });

      const gitignoreWrites = vi.mocked(freshFsp.writeFile).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(1);
      expect(gitignoreWrites[0][1]).toBe('.clubhouse/plugin-data-local/\n');
    });

    it('adds newline separator when existing content lacks trailing newline', async () => {
      vi.resetModules();
      vi.mock('fs/promises', () => ({
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        unlink: vi.fn(),
        access: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      }));
      const freshFsp = await import('fs/promises');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFsp.readFile).mockImplementation((async (p: string) => {
        if (typeof p === 'string' && p.endsWith('.gitignore')) return 'node_modules/';  // no trailing newline
        return '""';
      }) as any);

      await freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'x') });

      const gitignoreWrites = vi.mocked(freshFsp.writeFile).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites[0][1]).toBe('node_modules/\n.clubhouse/plugin-data-local/\n');
    });

    it('swallows gitignore errors gracefully', async () => {
      vi.resetModules();
      vi.mock('fs/promises', () => ({
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        unlink: vi.fn(),
        access: vi.fn(),
        readdir: vi.fn(),
        rm: vi.fn(),
      }));
      const freshFsp = await import('fs/promises');
      const freshStorage = await import('./plugin-storage');

      // readFile for .gitignore will fail — should be swallowed
      vi.mocked(freshFsp.readFile).mockRejectedValue(new Error('permission denied'));
      // writeFile for .gitignore will also fail — should be swallowed
      // But writeFile for the actual KV file should succeed
      vi.mocked(freshFsp.writeFile).mockImplementation(async (p: any) => {
        // The .gitignore write fails, the KV write succeeds
        if (typeof p === 'string' && p.endsWith('.gitignore')) {
          throw new Error('permission denied');
        }
      });

      // Should not throw — gitignore errors are swallowed
      await expect(
        freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'y') }),
      ).resolves.not.toThrow();
    });
  });
});
