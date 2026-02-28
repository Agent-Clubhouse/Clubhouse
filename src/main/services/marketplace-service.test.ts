import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  rmSync: vi.fn(),
  rmdirSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isDirectory: () => false })),
  rm: vi.fn(async () => undefined),
  rmdir: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
}));

const mockExtractAllTo = vi.fn();
vi.mock('adm-zip', () => ({
  default: vi.fn(function () {
    return { extractAllTo: mockExtractAllTo };
  }),
}));

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import AdmZip from 'adm-zip';
import {
  fetchRegistry,
  fetchCustomRegistry,
  fetchAllRegistries,
  installPlugin,
  _resetCache,
} from './marketplace-service';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const sampleRegistry = {
  version: 1,
  updated: '2025-01-01T00:00:00Z',
  plugins: [
    {
      id: 'test-plugin',
      name: 'Test Plugin',
      description: 'A test plugin',
      author: 'Test Author',
      official: true,
      repo: 'https://github.com/test/plugin',
      path: 'plugins/test',
      tags: ['test'],
      latest: '1.0.0',
      releases: {
        '1.0.0': {
          api: 0.5,
          asset: 'https://example.com/test-plugin-1.0.0.zip',
          sha256: 'abc123',
          permissions: ['storage', 'logging'],
          size: 1024,
        },
      },
    },
  ],
};

const sampleFeatured = {
  version: 1,
  updated: '2025-01-01T00:00:00Z',
  featured: [{ id: 'test-plugin', reason: 'Great plugin' }],
};

const sampleCustomRegistry = {
  version: 1,
  updated: '2025-01-01T00:00:00Z',
  plugins: [
    {
      id: 'custom-plugin',
      name: 'Custom Plugin',
      description: 'A private plugin',
      author: 'Private Author',
      official: false,
      repo: 'https://internal.example.com/custom-plugin',
      path: 'plugins/custom',
      tags: ['private'],
      latest: '2.0.0',
      releases: {
        '2.0.0': {
          api: 0.5,
          asset: 'https://internal.example.com/custom-plugin-2.0.0.zip',
          sha256: 'def456',
          permissions: ['storage'],
          size: 2048,
        },
      },
    },
  ],
};

describe('marketplace-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetCache();
  });

  describe('fetchRegistry', () => {
    it('fetches registry and featured JSON', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        });

      const result = await fetchRegistry();
      expect(result.registry.plugins).toHaveLength(1);
      expect(result.registry.plugins[0].id).toBe('test-plugin');
      expect(result.featured!.featured).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws on failed registry fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(fetchRegistry()).rejects.toThrow('Failed to fetch registry');
    });

    it('returns null featured when featured.json fetch fails', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found',
        });

      const result = await fetchRegistry();
      expect(result.registry.plugins).toHaveLength(1);
      expect(result.featured).toBeNull();
    });

    it('returns cached result within TTL', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        });

      const first = await fetchRegistry();
      const second = await fetchRegistry();

      // Only 2 calls total (registry + featured from first call)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(second).toEqual(first);
    });
  });

  describe('fetchCustomRegistry', () => {
    it('fetches a custom registry from URL', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleCustomRegistry,
        })
        .mockResolvedValueOnce({
          ok: false, // featured not available
        });

      const result = await fetchCustomRegistry({
        id: 'cm-1',
        name: 'My Store',
        url: 'https://internal.example.com/registry/registry.json',
        enabled: true,
      });

      expect(result.registry.plugins).toHaveLength(1);
      expect(result.registry.plugins[0].id).toBe('custom-plugin');
    });

    it('throws on failed custom registry fetch', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
      });

      await expect(
        fetchCustomRegistry({
          id: 'cm-1',
          name: 'Private Store',
          url: 'https://private.example.com/registry.json',
          enabled: true,
        }),
      ).rejects.toThrow('Failed to fetch custom registry');
    });

    it('caches custom registry results', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleCustomRegistry,
        })
        .mockResolvedValueOnce({
          ok: false,
        });

      const marketplace = {
        id: 'cm-1',
        name: 'My Store',
        url: 'https://internal.example.com/registry.json',
        enabled: true,
      };

      const first = await fetchCustomRegistry(marketplace);
      const second = await fetchCustomRegistry(marketplace);

      // Only 2 fetch calls total (registry + featured attempt from first call)
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(second.registry.plugins).toEqual(first.registry.plugins);
    });
  });

  describe('fetchAllRegistries', () => {
    it('merges official and custom registry plugins', async () => {
      // Official registry fetch (registry + featured)
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        })
        // Custom registry fetch (registry + featured attempt)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleCustomRegistry,
        })
        .mockResolvedValueOnce({
          ok: false,
        });

      const result = await fetchAllRegistries([
        { id: 'cm-1', name: 'Private Store', url: 'https://private.example.com/registry.json', enabled: true },
      ]);

      expect(result.allPlugins).toHaveLength(2);
      expect(result.allPlugins[0].id).toBe('test-plugin');
      expect(result.allPlugins[0].marketplaceId).toBeUndefined();
      expect(result.allPlugins[1].id).toBe('custom-plugin');
      expect(result.allPlugins[1].marketplaceId).toBe('cm-1');
      expect(result.allPlugins[1].marketplaceName).toBe('Private Store');
    });

    it('skips disabled custom marketplaces', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        });

      const result = await fetchAllRegistries([
        { id: 'cm-1', name: 'Disabled Store', url: 'https://disabled.example.com/registry.json', enabled: false },
      ]);

      // Only official plugins, no custom fetch calls
      expect(result.allPlugins).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(2); // official registry + featured only
    });

    it('deduplicates plugins — official takes precedence', async () => {
      const duplicateCustomRegistry = {
        ...sampleCustomRegistry,
        plugins: [
          { ...sampleCustomRegistry.plugins[0], id: 'test-plugin' }, // same ID as official
        ],
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => duplicateCustomRegistry,
        })
        .mockResolvedValueOnce({
          ok: false,
        });

      const result = await fetchAllRegistries([
        { id: 'cm-1', name: 'Store', url: 'https://store.example.com/registry.json', enabled: true },
      ]);

      // Only 1 plugin — official version wins
      expect(result.allPlugins).toHaveLength(1);
      expect(result.allPlugins[0].marketplaceId).toBeUndefined(); // official
    });

    it('handles custom registry fetch failure gracefully', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleRegistry,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => sampleFeatured,
        })
        .mockRejectedValueOnce(new Error('Network error'));

      const result = await fetchAllRegistries([
        { id: 'cm-1', name: 'Bad Store', url: 'https://bad.example.com/registry.json', enabled: true },
      ]);

      // Official plugins still present
      expect(result.allPlugins).toHaveLength(1);
      // Custom entry has error
      expect(result.custom).toHaveLength(1);
      expect(result.custom[0].error).toBe('Network error');
    });
  });

  describe('installPlugin', () => {
    it('returns error on download failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: 'abc123',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Download failed');
    });

    it('returns error on SHA-256 mismatch', async () => {
      const buffer = Buffer.from('fake zip content');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: 'definitely-wrong-hash',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Integrity check failed');
    });

    it('returns error when manifest.json is missing after extraction', async () => {
      const crypto = await import('crypto');
      const buffer = Buffer.from('fake zip content');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      // fsp.access for manifest.json check — reject means file missing
      vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fsp.readdir).mockResolvedValue([] as any);

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: hash,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('manifest.json');
    });

    it('writes .marketplace marker after successful install', async () => {
      const crypto = await import('crypto');
      const buffer = Buffer.from('fake zip content');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      // fsp.access for manifest.json check — resolve means file exists
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([] as any);

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: hash,
      });

      expect(result.success).toBe(true);
      // Verify .marketplace marker was written
      expect(fsp.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.marketplace'),
        '',
        'utf-8',
      );
    });

    it('uses adm-zip for extraction instead of shell command', async () => {
      const crypto = await import('crypto');
      const buffer = Buffer.from('fake zip content');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      // fsp.access for manifest.json check — resolve means file exists
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([] as any);

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: hash,
      });

      expect(result.success).toBe(true);
      expect(AdmZip).toHaveBeenCalledWith(expect.stringContaining('test-plugin.tmp.zip'));
      expect(mockExtractAllTo).toHaveBeenCalledWith(expect.stringContaining('test-plugin'), true);
    });

    it('returns error when adm-zip extraction fails', async () => {
      const crypto = await import('crypto');
      const buffer = Buffer.from('fake zip content');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('.tmp.zip')) return true;
        return false;
      });

      mockExtractAllTo.mockImplementation(() => {
        throw new Error('Invalid or unsupported zip format');
      });

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: hash,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid or unsupported zip format');
    });
  });
});
