import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WhisperBackend } from './whisper-backend';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
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

describe('WhisperBackend', () => {
  let backend: WhisperBackend;

  beforeEach(() => {
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

  it('transcribe returns text from whisper.cpp output', async () => {
    const audio = Buffer.alloc(32000); // 1 second of silence at 16kHz 16-bit
    const result = await backend.transcribe(audio);
    expect(result.text).toBe('Hello world');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
