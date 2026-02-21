import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperBackend } from './whisper-backend';

vi.mock('child_process', () => ({
  execFile: vi.fn((_cmd, _args, _opts, cb) => {
    if (cb) cb(null, 'Hello world\n', '');
    return { kill: vi.fn() };
  }),
}));

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdtempSync: vi.fn(() => '/tmp/whisper-test'),
  rmdirSync: vi.fn(),
}));

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

describe('WhisperBackend', () => {
  let backend: WhisperBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new WhisperBackend('/fake/bin/main', '/fake/models/ggml-base.en.bin');
  });

  it('has correct id and displayName', () => {
    expect(backend.id).toBe('whisper-local');
    expect(backend.displayName).toBe('Whisper (Local)');
  });

  it('isAvailable checks binary exists', async () => {
    const result = await backend.isAvailable();
    expect(result).toBe(true);
  });

  it('isAvailable returns false when binary missing', async () => {
    const fs = await import('fs');
    const existsSyncMock = vi.mocked(fs.existsSync);
    existsSyncMock.mockReturnValueOnce(false);
    const result = await backend.isAvailable();
    expect(result).toBe(false);
  });

  it('transcribe returns text from whisper.cpp output', async () => {
    const audio = Buffer.alloc(32000); // 1 second of silence at 16kHz 16-bit
    const result = await backend.transcribe(audio);
    expect(result.text).toBe('Hello world');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects on execFile error', async () => {
    const cp = await import('child_process');
    const execFileMock = vi.mocked(cp.execFile);
    execFileMock.mockImplementationOnce((_cmd: any, _args: any, _opts: any, cb: any) => {
      if (cb) cb(new Error('binary not found'), '', '');
      return { kill: vi.fn() } as any;
    });

    const audio = Buffer.alloc(32000);
    await expect(backend.transcribe(audio)).rejects.toThrow('binary not found');
  });

  it('cleans up temp files on error', async () => {
    const cp = await import('child_process');
    const fs = await import('fs');
    const execFileMock = vi.mocked(cp.execFile);
    execFileMock.mockImplementationOnce((_cmd: any, _args: any, _opts: any, cb: any) => {
      if (cb) cb(new Error('transcription failed'), '', '');
      return { kill: vi.fn() } as any;
    });

    const audio = Buffer.alloc(32000);
    await expect(backend.transcribe(audio)).rejects.toThrow('transcription failed');

    expect(fs.unlinkSync).toHaveBeenCalled();
    expect(fs.rmdirSync).toHaveBeenCalled();
  });
});
