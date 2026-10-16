/**
 * installPlugin against a real filesystem rooted in a per-test os.tmpdir()
 * home directory. Covers the audit finding that failure cleanup could delete
 * outside the plugins root (unsafe ids) or remove the existing install (any
 * failure during an update).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import AdmZip from 'adm-zip';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('electron', () => ({
  app: { getPath: (_name: string) => state.home },
}));

vi.mock('./log-service', () => ({ appLog: vi.fn() }));

// Real fs/promises, with rename wrapped so a test can inject a swap failure.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import * as fsp from 'fs/promises';
import { installPlugin } from './marketplace-service';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function pluginsDir(): string {
  return path.join(state.home, '.clubhouse', 'plugins');
}

function stagingRoot(): string {
  return path.join(state.home, '.clubhouse', '.plugin-staging');
}

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, 'utf-8'));
  }
  return zip.toBuffer();
}

function sha(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function serve(buffer: Buffer): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  });
}

/** Seed an existing install of `id` at v1.0.0. */
function seedExisting(id: string): string {
  const dir = path.join(pluginsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, version: '1.0.0' }));
  fs.writeFileSync(path.join(dir, 'old-only.txt'), 'v1');
  return dir;
}

function readVersion(dir: string): string {
  return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8')).version;
}

function expectStagingClean(): void {
  const leftovers = fs.existsSync(stagingRoot()) ? fs.readdirSync(stagingRoot()) : [];
  expect(leftovers).toEqual([]);
}

describe('installPlugin (real filesystem)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.home = fs.mkdtempSync(path.join(os.tmpdir(), 'clubhouse-marketplace-install-'));
  });

  afterEach(() => {
    fs.rmSync(state.home, { recursive: true, force: true });
  });

  describe('unsafe plugin ids', () => {
    const unsafeIds = [
      '../escape',
      '..',
      '.',
      '',
      'a/b',
      'a\\b',
      path.join(os.tmpdir(), 'abs-target'),
      'UPPER',
      'dots.in.id',
    ];

    it.each(unsafeIds)('rejects %j without fetching or touching the filesystem', async (pluginId) => {
      // Sentinel directly outside the plugins root — what '../escape' would hit.
      const sentinel = path.join(state.home, '.clubhouse', 'escape');
      fs.mkdirSync(sentinel, { recursive: true });
      fs.writeFileSync(path.join(sentinel, 'keep.txt'), 'keep');
      mockFetch.mockRejectedValue(new Error('network down'));

      const result = await installPlugin({ pluginId, version: '1.0.0', assetUrl: 'https://example.com/x.zip', sha256: 'abc' });

      expect(fs.existsSync(path.join(sentinel, 'keep.txt'))).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Invalid plugin id/);
    });
  });

  describe('failures leave an existing install untouched', () => {
    it('network rejection during update', async () => {
      const dir = seedExisting('my-plugin');
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: 'abc' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('fetch failed');
      expect(readVersion(dir)).toBe('1.0.0');
      expect(fs.existsSync(path.join(dir, 'old-only.txt'))).toBe(true);
      expectStagingClean();
    });

    it('HTTP error response', async () => {
      const dir = seedExisting('my-plugin');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: 'abc' });

      expect(result.success).toBe(false);
      expect(readVersion(dir)).toBe('1.0.0');
      expectStagingClean();
    });

    it('integrity check failure', async () => {
      const dir = seedExisting('my-plugin');
      serve(makeZip({ 'manifest.json': JSON.stringify({ id: 'my-plugin', version: '2.0.0' }) }));

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: 'wrong' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Integrity check failed');
      expect(readVersion(dir)).toBe('1.0.0');
      expectStagingClean();
    });

    it('archive without a manifest.json', async () => {
      const dir = seedExisting('my-plugin');
      const zip = makeZip({ 'readme.txt': 'no manifest here' });
      serve(zip);

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: sha(zip) });

      expect(result.success).toBe(false);
      expect(result.error).toContain('manifest.json');
      expect(readVersion(dir)).toBe('1.0.0');
      expectStagingClean();
    });

    it('corrupt archive', async () => {
      const dir = seedExisting('my-plugin');
      const garbage = Buffer.from('not a zip file at all');
      serve(garbage);

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: sha(garbage) });

      expect(result.success).toBe(false);
      expect(readVersion(dir)).toBe('1.0.0');
      expectStagingClean();
    });

    it('restores the previous install when the final swap fails', async () => {
      const dir = seedExisting('my-plugin');
      const zip = makeZip({ 'manifest.json': JSON.stringify({ id: 'my-plugin', version: '2.0.0' }) });
      serve(zip);

      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises');
      vi.mocked(fsp.rename).mockImplementation(async (from, to) => {
        // Fail only the "move new install into place" step.
        if (String(to) === dir && path.basename(String(from)) === 'plugin') {
          throw Object.assign(new Error('EPERM: simulated swap failure'), { code: 'EPERM' });
        }
        return actual.rename(from, to);
      });

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: sha(zip) });

      expect(result.success).toBe(false);
      expect(result.error).toContain('simulated swap failure');
      expect(readVersion(dir)).toBe('1.0.0');
      expect(fs.existsSync(path.join(dir, 'old-only.txt'))).toBe(true);
      expectStagingClean();

      vi.mocked(fsp.rename).mockImplementation(actual.rename);
    });
  });

  describe('successful installs', () => {
    it('replaces an existing install only after the new one validates', async () => {
      const dir = seedExisting('my-plugin');
      const zip = makeZip({
        'my-plugin/manifest.json': JSON.stringify({ id: 'my-plugin', version: '2.0.0' }),
        'my-plugin/main.js': 'export {}',
      });
      serve(zip);

      const result = await installPlugin({ pluginId: 'my-plugin', version: '2.0.0', assetUrl: 'https://example.com/p.zip', sha256: sha(zip) });

      expect(result).toEqual({ success: true });
      expect(readVersion(dir)).toBe('2.0.0');
      // Single top-level folder was hoisted
      expect(fs.existsSync(path.join(dir, 'main.js'))).toBe(true);
      // Old files do not linger
      expect(fs.existsSync(path.join(dir, 'old-only.txt'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.marketplace'))).toBe(true);
      // Plugins root contains only the plugin itself — no staging/temp artifacts
      expect(fs.readdirSync(pluginsDir())).toEqual(['my-plugin']);
      expectStagingClean();
    });

    it('performs a fresh install', async () => {
      const zip = makeZip({ 'manifest.json': JSON.stringify({ id: 'new-plugin', version: '1.0.0' }) });
      serve(zip);

      const result = await installPlugin({ pluginId: 'new-plugin', version: '1.0.0', assetUrl: 'https://example.com/p.zip', sha256: sha(zip) });

      expect(result).toEqual({ success: true });
      const dir = path.join(pluginsDir(), 'new-plugin');
      expect(readVersion(dir)).toBe('1.0.0');
      expect(fs.existsSync(path.join(dir, '.marketplace'))).toBe(true);
      expect(fs.readdirSync(pluginsDir())).toEqual(['new-plugin']);
      expectStagingClean();
    });
  });
});
