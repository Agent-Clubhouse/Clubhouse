import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => ['ggml-base.en.bin']),
  readFileSync: vi.fn(() => JSON.stringify({
    models: [{ id: 'ggml-base.en', name: 'base.en', sizeBytes: 148000000, sha256: 'abc' }],
  })),
  writeFileSync: vi.fn(),
  statSync: vi.fn(() => ({ size: 148000000 })),
  unlinkSync: vi.fn(),
}));

vi.mock('../log-service', () => ({ appLog: vi.fn() }));

import { ModelManager } from './model-manager';
import * as fs from 'fs';

describe('ModelManager', () => {
  let manager: ModelManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mocks
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(['ggml-base.en.bin'] as any);
    vi.mocked(fs.statSync).mockReturnValue({ size: 148000000 } as any);
    manager = new ModelManager();
  });

  it('listLocalModels finds downloaded STT models', () => {
    const models = manager.listLocalModels('stt');
    expect(models.length).toBeGreaterThan(0);
    expect(models[0].id).toBe('ggml-base.en');
    expect(models[0].kind).toBe('stt');
    expect(models[0].downloaded).toBe(true);
    expect(models[0].sizeBytes).toBe(148000000);
  });

  it('listLocalModels returns empty when dir missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const models = manager.listLocalModels('stt');
    expect(models).toEqual([]);
  });

  it('listLocalModels for tts finds onnx models', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      'en_US-lessac-medium.onnx',
      'en_US-lessac-medium.onnx.json',
    ] as any);
    vi.mocked(fs.statSync).mockReturnValue({ size: 64000000 } as any);

    const models = manager.listLocalModels('tts');
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('en_US-lessac-medium');
    expect(models[0].kind).toBe('tts');
    expect(models[0].downloaded).toBe(true);
    expect(models[0].sizeBytes).toBe(64000000);
  });

  it('listLocalModels for tts excludes onnx.json files', () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      'en_US-lessac-medium.onnx.json',
    ] as any);

    const models = manager.listLocalModels('tts');
    expect(models.length).toBe(0);
  });

  it('listLocalModels detects language from STT model id', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['ggml-base.en.bin', 'ggml-large.bin'] as any);
    const models = manager.listLocalModels('stt');
    expect(models[0].language).toBe('en');
    expect(models[1].language).toBe('multi');
  });

  it('getModelPath returns correct paths for stt', () => {
    const p = manager.getModelPath('stt', 'ggml-base.en');
    expect(p).toContain('stt');
    expect(p.endsWith('ggml-base.en.bin')).toBe(true);
  });

  it('getModelPath returns correct paths for tts', () => {
    const p = manager.getModelPath('tts', 'en_US-lessac-medium');
    expect(p).toContain('tts');
    expect(p.endsWith('en_US-lessac-medium.onnx')).toBe(true);
  });

  it('downloadModel creates directory and returns path', async () => {
    const onProgress = vi.fn();
    const result = await manager.downloadModel('stt', 'ggml-base.en', onProgress);
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('stt'),
      { recursive: true },
    );
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(result).toContain('ggml-base.en.bin');
  });

  it('deleteModel calls unlinkSync when file exists', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    await manager.deleteModel('stt', 'ggml-base.en');
    expect(fs.unlinkSync).toHaveBeenCalledWith(
      expect.stringContaining('ggml-base.en.bin'),
    );
  });

  it('deleteModel does nothing when file missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await manager.deleteModel('stt', 'ggml-base.en');
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it('getDefaults returns expected defaults', () => {
    const defaults = manager.getDefaults();
    expect(defaults.stt).toBe('ggml-base.en');
    expect(defaults.tts.length).toBeGreaterThanOrEqual(1);
    expect(defaults.tts).toContain('en_US-lessac-medium');
  });

  it('getModelPath rejects path traversal in modelId', () => {
    expect(() => manager.getModelPath('stt', '../../etc/passwd')).toThrow('Invalid model ID');
    expect(() => manager.getModelPath('tts', '../../../secret')).toThrow('Invalid model ID');
  });

  it('listLocalModels handles race condition when file disappears during iteration', () => {
    vi.mocked(fs.readdirSync).mockReturnValue(['ggml-base.en.bin', 'ggml-large.bin'] as any);
    vi.mocked(fs.statSync)
      .mockReturnValueOnce({ size: 148000000 } as any)
      .mockImplementationOnce(() => { throw new Error('ENOENT: no such file or directory'); });

    const models = manager.listLocalModels('stt');
    expect(models.length).toBe(1);
    expect(models[0].id).toBe('ggml-base.en');
  });
});
