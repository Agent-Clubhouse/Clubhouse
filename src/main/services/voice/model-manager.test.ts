import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  createWriteStream: vi.fn(() => ({
    close: vi.fn((cb: () => void) => cb()),
    on: vi.fn(),
  })),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import { checkModels, getModelPaths } from './model-manager';
import * as fs from 'fs';

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
});
