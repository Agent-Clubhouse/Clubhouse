import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((key: string) => {
      if (key === 'home') return '/mock-home';
      if (key === 'temp') return '/mock-temp';
      if (key === 'userData') return '/mock-userdata';
      return '/mock';
    }),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock marketplace-service
vi.mock('./marketplace-service', () => ({
  fetchAllRegistries: vi.fn(),
  installPlugin: vi.fn(),
}));

// Mock custom-marketplace-service
vi.mock('./custom-marketplace-service', () => ({
  listCustomMarketplaces: vi.fn(() => []),
}));

// Mock auto-update-service (for isNewerVersion)
vi.mock('./auto-update-service', () => ({
  isNewerVersion: vi.fn((a: string, b: string) => {
    // Simple comparison for tests
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return true;
      if ((pa[i] || 0) < (pb[i] || 0)) return false;
    }
    return false;
  }),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs';
import { fetchAllRegistries, installPlugin } from './marketplace-service';
import {
  checkForPluginUpdates,
  updatePlugin,
  getPluginUpdatesStatus,
  _resetState,
} from './plugin-update-service';

const samplePlugins = [
  {
    id: 'my-plugin',
    name: 'My Plugin',
    description: 'A test plugin',
    author: 'Test',
    official: false,
    repo: 'https://github.com/test/my-plugin',
    path: 'plugins/my-plugin',
    tags: ['test'],
    latest: '2.0.0',
    releases: {
      '1.0.0': {
        api: 0.5,
        asset: 'https://example.com/my-plugin-1.0.0.zip',
        sha256: 'abc',
        permissions: ['storage'],
        size: 1024,
      },
      '2.0.0': {
        api: 0.5,
        asset: 'https://example.com/my-plugin-2.0.0.zip',
        sha256: 'def',
        permissions: ['storage'],
        size: 2048,
      },
    },
  },
  {
    id: 'other-plugin',
    name: 'Other Plugin',
    description: 'Another plugin',
    author: 'Test',
    official: false,
    repo: 'https://github.com/test/other-plugin',
    path: 'plugins/other-plugin',
    tags: ['test'],
    latest: '1.0.0',
    releases: {
      '1.0.0': {
        api: 0.5,
        asset: 'https://example.com/other-1.0.0.zip',
        sha256: 'ghi',
        permissions: [],
        size: 512,
      },
    },
  },
];

const sampleAllRegistriesResult = {
  official: {
    registry: { version: 1, updated: '2025-01-01T00:00:00Z', plugins: samplePlugins },
    featured: null,
  },
  custom: [],
  allPlugins: samplePlugins,
};

describe('plugin-update-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetState();
  });

  describe('checkForPluginUpdates', () => {
    it('detects available updates for installed plugins', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);

      // Simulate installed plugins dir
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' })
      );

      const result = await checkForPluginUpdates();

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].pluginId).toBe('my-plugin');
      expect(result.updates[0].currentVersion).toBe('1.0.0');
      expect(result.updates[0].latestVersion).toBe('2.0.0');
      expect(result.updates[0].assetUrl).toBe('https://example.com/my-plugin-2.0.0.zip');
    });

    it('returns no updates when plugins are up to date', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '2.0.0' })
      );

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(0);
    });

    it('skips plugins not in the registry', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'unknown-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'unknown-plugin', name: 'Unknown', version: '1.0.0' })
      );

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(0);
    });

    it('returns empty when no plugins are installed', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(0);
    });

    it('handles registry fetch failure gracefully', async () => {
      vi.mocked(fetchAllRegistries).mockRejectedValue(new Error('Network error'));
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(0);

      const status = getPluginUpdatesStatus();
      expect(status.error).toBe('Network error');
      expect(status.checking).toBe(false);
    });

    it('skips malformed manifest files', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'bad-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue('not json');

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(0);
    });

    it('includes api field in PluginUpdateInfo', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' })
      );

      const result = await checkForPluginUpdates();

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].api).toBe(0.5);
    });

    it('skips updates with unsupported API versions', async () => {
      const incompatiblePlugin = {
        id: 'future-plugin',
        name: 'Future Plugin',
        description: 'Needs a new API',
        author: 'Test',
        official: false,
        repo: 'https://github.com/test/future',
        path: 'plugins/future',
        tags: [],
        latest: '2.0.0',
        releases: {
          '2.0.0': {
            api: 9.0, // Unsupported API version
            asset: 'https://example.com/future-2.0.0.zip',
            sha256: 'zzz',
            permissions: [],
            size: 512,
          },
        },
      };

      vi.mocked(fetchAllRegistries).mockResolvedValue({
        official: {
          registry: { version: 1, updated: '2025-01-01T00:00:00Z', plugins: [incompatiblePlugin] },
          featured: null,
        },
        custom: [],
        allPlugins: [incompatiblePlugin],
      } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'future-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'future-plugin', name: 'Future Plugin', version: '1.0.0' })
      );

      const result = await checkForPluginUpdates();

      // Should NOT appear in compatible updates
      expect(result.updates).toHaveLength(0);
      // Should appear in incompatible updates
      expect(result.incompatibleUpdates).toHaveLength(1);
      expect(result.incompatibleUpdates[0].pluginId).toBe('future-plugin');
      expect(result.incompatibleUpdates[0].requiredApi).toBe(9.0);
      expect(result.incompatibleUpdates[0].latestVersion).toBe('2.0.0');
    });

    it('tracks incompatible updates in status', async () => {
      const incompatiblePlugin = {
        id: 'future-plugin',
        name: 'Future Plugin',
        description: 'Needs a new API',
        author: 'Test',
        official: false,
        repo: 'https://github.com/test/future',
        path: 'plugins/future',
        tags: [],
        latest: '2.0.0',
        releases: {
          '2.0.0': {
            api: 9.0,
            asset: 'https://example.com/future-2.0.0.zip',
            sha256: 'zzz',
            permissions: [],
            size: 512,
          },
        },
      };

      vi.mocked(fetchAllRegistries).mockResolvedValue({
        official: {
          registry: { version: 1, updated: '2025-01-01T00:00:00Z', plugins: [incompatiblePlugin] },
          featured: null,
        },
        custom: [],
        allPlugins: [incompatiblePlugin],
      } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'future-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'future-plugin', name: 'Future Plugin', version: '1.0.0' })
      );

      await checkForPluginUpdates();

      const status = getPluginUpdatesStatus();
      expect(status.incompatibleUpdates).toHaveLength(1);
      expect(status.incompatibleUpdates[0].pluginId).toBe('future-plugin');
    });

    it('separates compatible and incompatible updates', async () => {
      const mixedPlugins = [
        ...samplePlugins,
        {
          id: 'future-plugin',
          name: 'Future Plugin',
          description: 'Needs a new API',
          author: 'Test',
          official: false,
          repo: 'https://github.com/test/future',
          path: 'plugins/future',
          tags: [],
          latest: '2.0.0',
          releases: {
            '2.0.0': {
              api: 9.0,
              asset: 'https://example.com/future-2.0.0.zip',
              sha256: 'zzz',
              permissions: [],
              size: 512,
            },
          },
        },
      ];

      vi.mocked(fetchAllRegistries).mockResolvedValue({
        official: {
          registry: { version: 1, updated: '2025-01-01T00:00:00Z', plugins: mixedPlugins },
          featured: null,
        },
        custom: [],
        allPlugins: mixedPlugins,
      } as any);

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true },
        { name: 'future-plugin', isDirectory: () => true },
      ] as any);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.includes('my-plugin')) return JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' });
        if (s.includes('future-plugin')) return JSON.stringify({ id: 'future-plugin', name: 'Future Plugin', version: '1.0.0' });
        return '{}';
      });

      const result = await checkForPluginUpdates();

      // my-plugin uses API 0.5 (supported) → compatible
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0].pluginId).toBe('my-plugin');

      // future-plugin uses API 9.0 (unsupported) → incompatible
      expect(result.incompatibleUpdates).toHaveLength(1);
      expect(result.incompatibleUpdates[0].pluginId).toBe('future-plugin');
    });

    it('detects multiple updates', async () => {
      const thirdPlugin = {
        id: 'third-plugin',
        name: 'Third Plugin',
        description: 'Third',
        author: 'Test',
        official: false,
        repo: 'https://github.com/test/third',
        path: 'plugins/third',
        tags: [],
        latest: '3.0.0',
        releases: {
          '3.0.0': {
            api: 0.5,
            asset: 'https://example.com/third-3.0.0.zip',
            sha256: 'xyz',
            permissions: [],
            size: 256,
          },
        },
      };

      const extendedPlugins = [...samplePlugins, thirdPlugin];
      vi.mocked(fetchAllRegistries).mockResolvedValue({
        official: {
          registry: { version: 1, updated: '2025-01-01T00:00:00Z', plugins: extendedPlugins },
          featured: null,
        },
        custom: [],
        allPlugins: extendedPlugins,
      } as any);

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        return s.includes('plugins') || s.includes('manifest');
      });
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true },
        { name: 'third-plugin', isDirectory: () => true },
      ] as any);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.includes('my-plugin')) return JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' });
        if (s.includes('third-plugin')) return JSON.stringify({ id: 'third-plugin', name: 'Third', version: '1.0.0' });
        return '{}';
      });

      const result = await checkForPluginUpdates();
      expect(result.updates).toHaveLength(2);
      expect(result.updates.map((u) => u.pluginId)).toContain('my-plugin');
      expect(result.updates.map((u) => u.pluginId)).toContain('third-plugin');
    });
  });

  describe('updatePlugin', () => {
    it('returns error when no update is available', async () => {
      const result = await updatePlugin('nonexistent');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No update available');
    });

    it('calls installPlugin and returns success', async () => {
      // First, set up an available update
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' })
      );

      await checkForPluginUpdates();

      vi.mocked(installPlugin).mockResolvedValue({ success: true });

      const result = await updatePlugin('my-plugin');
      expect(result.success).toBe(true);
      expect(result.newVersion).toBe('2.0.0');
      expect(installPlugin).toHaveBeenCalledWith({
        pluginId: 'my-plugin',
        version: '2.0.0',
        assetUrl: 'https://example.com/my-plugin-2.0.0.zip',
        sha256: 'def',
      });

      // Plugin should be removed from updates list
      const status = getPluginUpdatesStatus();
      expect(status.updates.find((u) => u.pluginId === 'my-plugin')).toBeUndefined();
    });

    it('returns error when installation fails', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' })
      );

      await checkForPluginUpdates();

      vi.mocked(installPlugin).mockResolvedValue({
        success: false,
        error: 'SHA-256 mismatch',
      });

      const result = await updatePlugin('my-plugin');
      expect(result.success).toBe(false);
      expect(result.error).toBe('SHA-256 mismatch');

      // Plugin should still be in updates list
      const status = getPluginUpdatesStatus();
      expect(status.updates.find((u) => u.pluginId === 'my-plugin')).toBeDefined();
    });

    it('clears updating state on failure', async () => {
      vi.mocked(fetchAllRegistries).mockResolvedValue(sampleAllRegistriesResult as any);
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockReturnValue([
        { name: 'my-plugin', isDirectory: () => true } as any,
      ]);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ id: 'my-plugin', name: 'My Plugin', version: '1.0.0' })
      );

      await checkForPluginUpdates();
      vi.mocked(installPlugin).mockRejectedValue(new Error('Network timeout'));

      const result = await updatePlugin('my-plugin');
      expect(result.success).toBe(false);

      const status = getPluginUpdatesStatus();
      expect(status.updating).toEqual({});
    });
  });

  describe('getPluginUpdatesStatus', () => {
    it('returns initial status', () => {
      const status = getPluginUpdatesStatus();
      expect(status.updates).toEqual([]);
      expect(status.incompatibleUpdates).toEqual([]);
      expect(status.checking).toBe(false);
      expect(status.lastCheck).toBeNull();
      expect(status.updating).toEqual({});
      expect(status.error).toBeNull();
    });
  });
});
