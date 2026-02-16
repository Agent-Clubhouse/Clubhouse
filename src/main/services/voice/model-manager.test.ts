import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/home/test'),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  statSync: vi.fn(() => ({ size: 100 })),
  mkdirSync: vi.fn(),
  rmSync: vi.fn(),
  createWriteStream: vi.fn(() => ({
    close: vi.fn((cb: () => void) => cb()),
    on: vi.fn(),
  })),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('https', () => ({
  get: vi.fn(),
}));

vi.mock('http', () => ({
  get: vi.fn(),
}));

import {
  checkModels,
  getModelPaths,
  deleteModels,
  getModelUrls,
  downloadModels,
  downloadFile,
} from './model-manager';
import * as fs from 'fs';
import * as https from 'https';

// --- Helpers for download tests ---

function createMockWriteStream() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    close: vi.fn((cb?: () => void) => { if (cb) cb(); }),
  });
}

function createMockResponse(statusCode: number, headers: Record<string, string> = {}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode,
    headers,
    pipe: vi.fn((dest: EventEmitter) => {
      process.nextTick(() => dest.emit('finish'));
      return dest;
    }),
  });
}

/**
 * Configure mocks so only the whisper model needs downloading.
 * All other models are treated as ready (existsSync true + size > 0).
 */
function setupSingleModelDownload() {
  vi.mocked(fs.existsSync).mockImplementation((p: any) => {
    return !String(p).endsWith('ggml-base.en.bin');
  });
  vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
}

describe('model-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkModels', () => {
    it('returns an array of model info objects', () => {
      const models = checkModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
    });

    it('each model has name, path, size, and ready fields', () => {
      const models = checkModels();
      for (const model of models) {
        expect(model).toHaveProperty('name');
        expect(model).toHaveProperty('path');
        expect(model).toHaveProperty('size');
        expect(model).toHaveProperty('ready');
        expect(typeof model.name).toBe('string');
        expect(typeof model.path).toBe('string');
        expect(typeof model.size).toBe('number');
        expect(typeof model.ready).toBe('boolean');
      }
    });

    it('reports models as not ready when files do not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const models = checkModels();
      for (const model of models) {
        expect(model.ready).toBe(false);
      }
    });

    it('reports models as ready when files exist with non-zero size', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.statSync).mockReturnValue({ size: 1000 } as any);
      const models = checkModels();
      for (const model of models) {
        expect(model.ready).toBe(true);
      }
    });

    it('creates models directory if it does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      checkModels();
      expect(fs.mkdirSync).toHaveBeenCalled();
    });

    it('includes whisper model', () => {
      const models = checkModels();
      const whisper = models.find((m) => m.name.includes('ggml'));
      expect(whisper).toBeDefined();
    });

    it('includes piper voice model', () => {
      const models = checkModels();
      const piper = models.find((m) => m.name.includes('vctk'));
      expect(piper).toBeDefined();
    });

    it('includes piper binary', () => {
      const models = checkModels();
      const binary = models.find((m) => m.name === 'piper');
      expect(binary).toBeDefined();
    });
  });

  describe('deleteModels', () => {
    it('removes the models directory when it exists', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      deleteModels();
      expect(fs.rmSync).toHaveBeenCalledWith(
        expect.stringContaining('voice-models'),
        { recursive: true },
      );
    });

    it('does not throw when models directory does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(() => deleteModels()).not.toThrow();
      expect(fs.rmSync).not.toHaveBeenCalled();
    });
  });

  describe('getModelPaths', () => {
    it('returns paths for all models', () => {
      const paths = getModelPaths();
      expect(paths).toHaveProperty('whisper');
      expect(paths).toHaveProperty('piperBinary');
      expect(paths).toHaveProperty('piperVoice');
      expect(paths).toHaveProperty('piperVoiceConfig');
    });

    it('all paths are strings', () => {
      const paths = getModelPaths();
      expect(typeof paths.whisper).toBe('string');
      expect(typeof paths.piperBinary).toBe('string');
      expect(typeof paths.piperVoice).toBe('string');
      expect(typeof paths.piperVoiceConfig).toBe('string');
    });

    it('paths are under ~/.clubhouse/voice-models/', () => {
      const paths = getModelPaths();
      for (const p of Object.values(paths)) {
        expect(p).toContain('voice-models');
      }
    });
  });

  describe('downloadModels', () => {
    describe('URL validity', () => {
      it('all model URLs parse as valid URLs', () => {
        const urls = getModelUrls();
        expect(urls.length).toBeGreaterThanOrEqual(4);
        for (const url of urls) {
          expect(() => new URL(url)).not.toThrow();
        }
      });

      it('all model URLs use HTTPS', () => {
        for (const url of getModelUrls()) {
          expect(new URL(url).protocol).toBe('https:');
        }
      });
    });

    describe('successful download', () => {
      it('writes to temp file and renames on success', async () => {
        setupSingleModelDownload();
        vi.mocked(fs.createWriteStream).mockImplementation(() => createMockWriteStream() as any);

        vi.mocked(https.get).mockImplementation((_url: any, cb: any) => {
          const response = createMockResponse(200, { 'content-length': '1000' });
          process.nextTick(() => cb(response));
          return new EventEmitter() as any;
        });

        await downloadModels();

        expect(fs.createWriteStream).toHaveBeenCalledWith(expect.stringContaining('.tmp'));
        expect(fs.renameSync).toHaveBeenCalled();
      });
    });

    describe('redirect handling', () => {
      it('follows absolute redirect', async () => {
        setupSingleModelDownload();
        vi.mocked(fs.createWriteStream).mockImplementation(() => createMockWriteStream() as any);

        let callCount = 0;
        vi.mocked(https.get).mockImplementation((_url: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const response = createMockResponse(302, { location: 'https://cdn.example.com/model.bin' });
            process.nextTick(() => cb(response));
          } else {
            const response = createMockResponse(200, { 'content-length': '1000' });
            process.nextTick(() => cb(response));
          }
          return new EventEmitter() as any;
        });

        await downloadModels();

        expect(https.get).toHaveBeenCalledTimes(2);
        const secondUrl = vi.mocked(https.get).mock.calls[1][0] as URL;
        expect(secondUrl.href).toBe('https://cdn.example.com/model.bin');
      });

      it('resolves relative redirect against original URL', async () => {
        setupSingleModelDownload();
        vi.mocked(fs.createWriteStream).mockImplementation(() => createMockWriteStream() as any);

        let callCount = 0;
        vi.mocked(https.get).mockImplementation((_url: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            const response = createMockResponse(302, { location: '/cdn/model.bin' });
            process.nextTick(() => cb(response));
          } else {
            const response = createMockResponse(200, { 'content-length': '1000' });
            process.nextTick(() => cb(response));
          }
          return new EventEmitter() as any;
        });

        await downloadModels();

        expect(https.get).toHaveBeenCalledTimes(2);
        const secondUrl = vi.mocked(https.get).mock.calls[1][0] as URL;
        expect(secondUrl.pathname).toBe('/cdn/model.bin');
        expect(secondUrl.hostname).toBe('huggingface.co');
      });
    });

    describe('HTTP error', () => {
      it('rejects with descriptive error on 404', async () => {
        setupSingleModelDownload();
        vi.mocked(fs.createWriteStream).mockImplementation(() => createMockWriteStream() as any);

        vi.mocked(https.get).mockImplementation((_url: any, cb: any) => {
          const response = createMockResponse(404);
          process.nextTick(() => cb(response));
          return new EventEmitter() as any;
        });

        await expect(downloadModels()).rejects.toThrow('HTTP 404');
      });
    });

    describe('invalid URL rejection', () => {
      it('rejects with "Invalid download URL" for garbage URL', async () => {
        await expect(downloadFile('not-a-url', '/tmp/dest', 'test')).rejects.toThrow('Invalid download URL');
      });
    });

    describe('network error', () => {
      it('rejects and cleans up temp file on network error', async () => {
        setupSingleModelDownload();
        vi.mocked(fs.createWriteStream).mockImplementation(() => createMockWriteStream() as any);

        vi.mocked(https.get).mockImplementation((_url: any, _cb: any) => {
          const request = new EventEmitter();
          process.nextTick(() => request.emit('error', new Error('ECONNREFUSED')));
          return request as any;
        });

        await expect(downloadModels()).rejects.toThrow('ECONNREFUSED');
      });
    });
  });
});
