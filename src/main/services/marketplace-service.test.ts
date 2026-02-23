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

const mockExtractAllTo = vi.fn();
vi.mock('adm-zip', () => ({
  default: vi.fn(() => ({
    extractAllTo: mockExtractAllTo,
  })),
}));

import * as fs from 'fs';
import AdmZip from 'adm-zip';
import { fetchRegistry, installPlugin, _resetCache } from './marketplace-service';

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

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('manifest.json')) return false;
        if (s.endsWith('.tmp.zip')) return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

      const result = await installPlugin({
        pluginId: 'test-plugin',
        version: '1.0.0',
        assetUrl: 'https://example.com/test.zip',
        sha256: hash,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('manifest.json');
    });

    it('uses adm-zip for extraction instead of shell command', async () => {
      const crypto = await import('crypto');
      const buffer = Buffer.from('fake zip content');
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      });

      vi.mocked(fs.existsSync).mockImplementation((p: any) => {
        const s = String(p);
        if (s.endsWith('manifest.json')) return true;
        if (s.endsWith('.tmp.zip')) return true;
        return false;
      });

      vi.mocked(fs.readdirSync).mockReturnValue([] as any);

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
