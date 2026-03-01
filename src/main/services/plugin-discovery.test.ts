import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
  promises: {
    lstat: vi.fn(),
    unlink: vi.fn(),
    rm: vi.fn(),
  },
}));

import * as fs from 'fs';
import { discoverCommunityPlugins, uninstallPlugin } from './plugin-discovery';

const PLUGINS_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'plugins');
const PLUGIN_DATA_DIR = path.join(os.tmpdir(), 'clubhouse-test-home', '.clubhouse', 'plugin-data');

describe('plugin-discovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('discoverCommunityPlugins', () => {
    it('returns empty array when plugins dir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(discoverCommunityPlugins()).toEqual([]);
    });

    it('discovers plugins with valid manifest.json', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(result[0].pluginPath).toBe(path.join(PLUGINS_DIR, 'my-plugin'));
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('sets fromMarketplace true when .marketplace marker exists', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'market-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'market-plugin',
        name: 'Market Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(true);
    });

    it('sets fromMarketplace false when .marketplace marker is absent', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.marketplace')) return false;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'local-plugin', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'local-plugin',
        name: 'Local Plugin',
        version: '1.0.0',
        engine: { api: 0.5 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].fromMarketplace).toBe(false);
    });

    it('skips non-directory entries', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'readme.md', isDirectory: () => false, isSymbolicLink: () => false },
      ] as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips directories without manifest.json', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return false;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'incomplete', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips plugins with invalid JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'bad-json', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockReturnValue('{{not valid json');

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('discovers multiple plugins', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'plugin-a', isDirectory: () => true, isSymbolicLink: () => false },
        { name: 'plugin-b', isDirectory: () => true, isSymbolicLink: () => false },
      ] as any);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.includes('plugin-a')) {
          return JSON.stringify({ id: 'plugin-a', name: 'A', version: '1.0.0', engine: { api: 0.1 }, scope: 'project' });
        }
        return JSON.stringify({ id: 'plugin-b', name: 'B', version: '2.0.0', engine: { api: 0.1 }, scope: 'app' });
      });

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.manifest.id)).toEqual(['plugin-a', 'plugin-b']);
    });

    it('discovers symlinked plugin directories', () => {
      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s === PLUGINS_DIR) return true;
        if (s.endsWith('manifest.json')) return true;
        return false;
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => true } as any);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
        id: 'my-plugin',
        name: 'My Plugin',
        version: '1.0.0',
        engine: { api: 0.1 },
        scope: 'project',
      }));

      const result = discoverCommunityPlugins();
      expect(result).toHaveLength(1);
      expect(result[0].manifest.id).toBe('my-plugin');
      expect(fs.statSync).toHaveBeenCalledWith(path.join(PLUGINS_DIR, 'my-plugin'));
    });

    it('skips symlinks pointing to non-directories', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'some-file', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockReturnValue({ isDirectory: () => false } as any);

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('skips broken symlinks', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'broken-link', isDirectory: () => false, isSymbolicLink: () => true },
      ] as any);
      vi.mocked(fs.statSync).mockImplementation(() => { throw new Error('ENOENT'); });

      const result = discoverCommunityPlugins();
      expect(result).toEqual([]);
    });

    it('handles unreadable plugins dir gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('EACCES'); });
      expect(discoverCommunityPlugins()).toEqual([]);
    });
  });

  describe('uninstallPlugin', () => {
    it('removes plugin directory recursively with async rm', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('removes only the symlink when plugin is a symlink', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => true,
      } as any);
      vi.mocked(fs.promises.unlink).mockResolvedValue(undefined);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('linked-plugin');

      expect(fs.promises.unlink).toHaveBeenCalledWith(
        path.join(PLUGINS_DIR, 'linked-plugin'),
      );
      // rm is still called for data dir cleanup
      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'linked-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does nothing when plugin path does not exist', async () => {
      vi.mocked(fs.promises.lstat).mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      await uninstallPlugin('nonexistent');

      expect(fs.promises.rm).not.toHaveBeenCalled();
      expect(fs.promises.unlink).not.toHaveBeenCalled();
    });

    it('cleans up plugin data directory on uninstall', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      vi.mocked(fs.promises.rm).mockResolvedValue(undefined);

      await uninstallPlugin('my-plugin');

      expect(fs.promises.rm).toHaveBeenCalledWith(
        path.join(PLUGIN_DATA_DIR, 'my-plugin'),
        { recursive: true, force: true },
      );
    });

    it('does not fail if data directory cleanup throws', async () => {
      vi.mocked(fs.promises.lstat).mockResolvedValue({
        isSymbolicLink: () => false,
      } as any);
      let callCount = 0;
      vi.mocked(fs.promises.rm).mockImplementation(async () => {
        callCount++;
        if (callCount === 2) throw new Error('ENOENT');
      });

      // Should not throw even if data dir rm fails
      await expect(uninstallPlugin('my-plugin')).resolves.toBeUndefined();
    });
  });
});
