import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  rmSync: vi.fn(),
}));

import * as fs from 'fs';
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
    it('reads and parses JSON from kv directory', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ hello: 'world' }));
      const result = readKey({ pluginId: 'my-plugin', scope: 'global', key: 'config' });
      expect(result).toEqual({ hello: 'world' });
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'config.json'),
        'utf-8',
      );
    });

    it('returns undefined when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = readKey({ pluginId: 'my-plugin', scope: 'global', key: 'missing' });
      expect(result).toBeUndefined();
    });

    it('uses project-scoped path when scope is project', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('"value"');
      const projectPath = path.join(path.sep, 'projects', 'foo');
      readKey({ pluginId: 'my-plugin', scope: 'project', key: 'data', projectPath });
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data', 'my-plugin', 'kv', 'data.json'),
        'utf-8',
      );
    });

    it('rejects path traversal attempts', () => {
      expect(() =>
        readKey({ pluginId: 'my-plugin', scope: 'global', key: '../../etc/passwd' }),
      ).toThrow('Path traversal');
    });
  });

  describe('writeKey', () => {
    it('writes JSON to kv directory and ensures dir exists', () => {
      writeKey({ pluginId: 'my-plugin', scope: 'global', key: 'config', value: { a: 1 } });
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv'),
        { recursive: true },
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'config.json'),
        JSON.stringify({ a: 1 }),
        'utf-8',
      );
    });

    it('rejects path traversal in key', () => {
      expect(() =>
        writeKey({ pluginId: 'p', scope: 'global', key: '../../../evil', value: 'x' }),
      ).toThrow('Path traversal');
    });
  });

  describe('deleteKey', () => {
    it('unlinks the key file', () => {
      deleteKey({ pluginId: 'my-plugin', scope: 'global', key: 'old' });
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        path.join(GLOBAL_BASE, 'my-plugin', 'kv', 'old.json'),
      );
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() => deleteKey({ pluginId: 'p', scope: 'global', key: 'missing' })).not.toThrow();
    });

    it('rejects path traversal in key', () => {
      expect(() =>
        deleteKey({ pluginId: 'p', scope: 'global', key: '../../bad' }),
      ).toThrow('Path traversal');
    });
  });

  describe('listKeys', () => {
    it('returns key names without .json extension', () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['config.json', 'state.json', 'readme.txt'] as any);
      const keys = listKeys({ pluginId: 'my-plugin', scope: 'global' });
      expect(keys).toEqual(['config', 'state']);
    });

    it('returns empty array when directory does not exist', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const keys = listKeys({ pluginId: 'my-plugin', scope: 'global' });
      expect(keys).toEqual([]);
    });
  });

  // ── Raw File Operations ─────────────────────────────────────────────

  describe('readPluginFile', () => {
    it('reads file at the resolved path', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('file content');
      const result = readPluginFile({
        pluginId: 'p',
        scope: 'global',
        relativePath: 'data/notes.txt',
      });
      expect(result).toBe('file content');
    });

    it('rejects path traversal', () => {
      expect(() =>
        readPluginFile({ pluginId: 'p', scope: 'global', relativePath: '../../secret' }),
      ).toThrow('Path traversal');
    });
  });

  describe('writePluginFile', () => {
    it('writes file and creates parent directories', () => {
      writePluginFile({
        pluginId: 'p',
        scope: 'global',
        relativePath: 'data/out.txt',
        content: 'hello',
      });
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('data', 'out.txt')),
        'hello',
        'utf-8',
      );
    });

    it('rejects path traversal', () => {
      expect(() =>
        writePluginFile({ pluginId: 'p', scope: 'global', relativePath: '../bad', content: 'x' }),
      ).toThrow('Path traversal');
    });
  });

  describe('deletePluginFile', () => {
    it('unlinks the file', () => {
      deletePluginFile({ pluginId: 'p', scope: 'global', relativePath: 'old.txt' });
      expect(fs.unlinkSync).toHaveBeenCalled();
    });

    it('does not throw when file does not exist', () => {
      vi.mocked(fs.unlinkSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(() =>
        deletePluginFile({ pluginId: 'p', scope: 'global', relativePath: 'missing.txt' }),
      ).not.toThrow();
    });
  });

  describe('pluginFileExists', () => {
    it('returns true when file exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      expect(pluginFileExists({ pluginId: 'p', scope: 'global', relativePath: 'data.json' })).toBe(true);
    });

    it('returns false when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(pluginFileExists({ pluginId: 'p', scope: 'global', relativePath: 'nope' })).toBe(false);
    });
  });

  describe('listPluginDir', () => {
    it('returns directory entries with isDirectory flag', () => {
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'sub', isDirectory: () => true },
        { name: 'file.txt', isDirectory: () => false },
      ] as any);
      const entries = listPluginDir({ pluginId: 'p', scope: 'global', relativePath: '.' });
      expect(entries).toEqual([
        { name: 'sub', isDirectory: true },
        { name: 'file.txt', isDirectory: false },
      ]);
    });

    it('returns empty array when directory does not exist', () => {
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(listPluginDir({ pluginId: 'p', scope: 'global', relativePath: '.' })).toEqual([]);
    });
  });

  describe('mkdirPlugin', () => {
    it('creates directory recursively', () => {
      mkdirPlugin('p', 'global', 'sub/dir');
      expect(fs.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining(path.join('sub', 'dir')),
        { recursive: true },
      );
    });

    it('rejects path traversal', () => {
      expect(() => mkdirPlugin('p', 'global', '../../escape')).toThrow('Path traversal');
    });
  });

  // ── project-local scope ──────────────────────────────────────────────

  describe('project-local scope', () => {
    const projectPath = path.join(path.sep, 'projects', 'foo');

    it('readKey uses plugin-data-local path', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('"value"');
      readKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'data', projectPath });
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'data.json'),
        'utf-8',
      );
    });

    it('writeKey uses plugin-data-local path', () => {
      writeKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'config', value: 42, projectPath });
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'config.json'),
        '42',
        'utf-8',
      );
    });

    it('deleteKey uses plugin-data-local path', () => {
      deleteKey({ pluginId: 'my-plugin', scope: 'project-local', key: 'old', projectPath });
      expect(fs.unlinkSync).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv', 'old.json'),
      );
    });

    it('listKeys uses plugin-data-local path', () => {
      vi.mocked(fs.readdirSync).mockReturnValue(['a.json'] as any);
      listKeys({ pluginId: 'my-plugin', scope: 'project-local', projectPath });
      expect(fs.readdirSync).toHaveBeenCalledWith(
        path.join(projectPath, '.clubhouse', 'plugin-data-local', 'my-plugin', 'kv'),
      );
    });

    it('rejects path traversal for project-local', () => {
      expect(() =>
        readKey({ pluginId: 'p', scope: 'project-local', key: '../../etc/passwd', projectPath }),
      ).toThrow('Path traversal');
    });
  });

  // ── ensurePluginDataLocalGitignored ──────────────────────────────────

  describe('ensurePluginDataLocalGitignored', () => {
    it('only project-local writeKey triggers gitignore logic (not project or global)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      writeKey({ pluginId: 'p', scope: 'global', key: 'k', value: 'v' });
      // Global write should not touch .gitignore
      expect(fs.readFileSync).not.toHaveBeenCalledWith(
        expect.stringContaining('.gitignore'),
        expect.any(String),
      );

      vi.clearAllMocks();
      writeKey({ pluginId: 'p', scope: 'project', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'foo') });
      // Project write should not touch .gitignore either
      const gitignoreCalls = vi.mocked(fs.writeFileSync).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].includes('.gitignore'),
      );
      expect(gitignoreCalls).toHaveLength(0);
    });
  });

  // ── ensurePluginDataLocalGitignored (isolated) ──────────────────────

  describe('ensurePluginDataLocalGitignored (fresh module)', () => {
    it('appends pattern when .gitignore exists without it', async () => {
      // Use resetModules to clear the gitignoreEnsured Set
      vi.resetModules();
      vi.mock('fs', () => ({
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      const freshFs = await import('fs');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFs.existsSync).mockReturnValue(true);
      vi.mocked(freshFs.readFileSync).mockImplementation(((p: string) => {
        if (p.endsWith('.gitignore')) return 'node_modules/\n';
        return '""';
      }) as typeof freshFs.readFileSync);

      freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'bar') });

      const gitignoreWrites = vi.mocked(freshFs.writeFileSync).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(1);
      expect(gitignoreWrites[0][1]).toContain('.clubhouse/plugin-data-local/');
    });

    it('skips write if pattern already present', async () => {
      vi.resetModules();
      vi.mock('fs', () => ({
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      const freshFs = await import('fs');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFs.existsSync).mockReturnValue(true);
      vi.mocked(freshFs.readFileSync).mockImplementation(((p: string) => {
        if (p.endsWith('.gitignore')) return '.clubhouse/plugin-data-local/\n';
        return '""';
      }) as typeof freshFs.readFileSync);

      freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'bar') });

      const gitignoreWrites = vi.mocked(freshFs.writeFileSync).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(0);
    });

    it('creates .gitignore file if missing', async () => {
      vi.resetModules();
      vi.mock('fs', () => ({
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      const freshFs = await import('fs');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFs.existsSync).mockReturnValue(false);

      freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'baz') });

      const gitignoreWrites = vi.mocked(freshFs.writeFileSync).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites).toHaveLength(1);
      expect(gitignoreWrites[0][1]).toBe('.clubhouse/plugin-data-local/\n');
    });

    it('adds newline separator when existing content lacks trailing newline', async () => {
      vi.resetModules();
      vi.mock('fs', () => ({
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      const freshFs = await import('fs');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFs.existsSync).mockReturnValue(true);
      vi.mocked(freshFs.readFileSync).mockImplementation(((p: string) => {
        if (p.endsWith('.gitignore')) return 'node_modules/';  // no trailing newline
        return '""';
      }) as typeof freshFs.readFileSync);

      freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'x') });

      const gitignoreWrites = vi.mocked(freshFs.writeFileSync).mock.calls.filter(
        (c) => typeof c[0] === 'string' && c[0].endsWith('.gitignore'),
      );
      expect(gitignoreWrites[0][1]).toBe('node_modules/\n.clubhouse/plugin-data-local/\n');
    });

    it('swallows errors gracefully', async () => {
      vi.resetModules();
      vi.mock('fs', () => ({
        readFileSync: vi.fn(),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
        unlinkSync: vi.fn(),
        existsSync: vi.fn(),
        readdirSync: vi.fn(),
        rmSync: vi.fn(),
      }));
      const freshFs = await import('fs');
      const freshStorage = await import('./plugin-storage');

      vi.mocked(freshFs.existsSync).mockImplementation(() => { throw new Error('permission denied'); });

      // Should not throw
      expect(() => {
        freshStorage.writeKey({ pluginId: 'p', scope: 'project-local', key: 'k', value: 'v', projectPath: path.join(path.sep, 'projects', 'y') });
      }).not.toThrow();
    });
  });
});
