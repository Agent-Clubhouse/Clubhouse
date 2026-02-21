import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiperBackend } from './piper-backend';

const mockSpawn = vi.fn(() => {
  const { EventEmitter } = require('events');
  const { Readable, Writable } = require('stream');
  const proc = new EventEmitter();
  proc.stdin = new Writable({ write(_chunk: any, _enc: any, cb: () => void) { cb(); } });
  proc.stdin.on('error', () => {});
  proc.stdout = new Readable({
    read() {
      this.push(Buffer.alloc(4410)); // 0.1s at 22050Hz 16-bit mono
      this.push(null);
    },
  });
  proc.stderr = new Readable({ read() { this.push(null); } });
  proc.kill = vi.fn();
  setTimeout(() => proc.emit('close', 0), 10);
  return proc;
});

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => mockSpawn(...args),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true),
  readdirSync: vi.fn(() => ['en_US-lessac-medium.onnx', 'en_US-lessac-medium.onnx.json']),
  readFileSync: vi.fn(() => JSON.stringify({
    audio: { sample_rate: 22050 },
    language: { code: 'en_US' },
    espeak: { voice: 'en-us' },
  })),
}));

vi.mock('../../log-service', () => ({
  appLog: vi.fn(),
}));

describe('PiperBackend', () => {
  let backend: PiperBackend;

  beforeEach(() => {
    vi.clearAllMocks();
    backend = new PiperBackend('/fake/bin/piper', '/fake/models/tts');
  });

  it('has correct id and displayName', () => {
    expect(backend.id).toBe('piper-local');
    expect(backend.displayName).toBe('Piper (Local)');
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

  it('listVoices finds downloaded voice models', async () => {
    const voices = await backend.listVoices();
    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0].voiceId).toBe('en_US-lessac-medium');
  });

  it('listVoices reads language from config json', async () => {
    const voices = await backend.listVoices();
    expect(voices[0].language).toBe('en_US');
  });

  it('listVoices returns empty array when modelsDir does not exist', async () => {
    const fs = await import('fs');
    const existsSyncMock = vi.mocked(fs.existsSync);
    // existsSync is called for modelsDir — return false for it
    existsSyncMock.mockReturnValueOnce(false);
    const voices = await backend.listVoices();
    expect(voices).toEqual([]);
  });

  it('synthesize returns audio buffer', async () => {
    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const };
    const audio = await backend.synthesize('Hello world', voice);
    expect(audio.length).toBeGreaterThan(0);
  });

  it('synthesize spawns piper with correct model path', async () => {
    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const };
    await backend.synthesize('Hello world', voice);
    expect(mockSpawn).toHaveBeenCalledWith('/fake/bin/piper', expect.arrayContaining([
      '--model', expect.stringContaining('en_US-lessac-medium.onnx'),
      '--output_raw',
    ]));
  });

  it('synthesize passes speed as length-scale', async () => {
    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const, speed: 2.0 };
    await backend.synthesize('Hello world', voice);
    expect(mockSpawn).toHaveBeenCalledWith('/fake/bin/piper', expect.arrayContaining([
      '--length-scale', '0.5',
    ]));
  });

  it('rejects on piper process error', async () => {
    const { EventEmitter } = require('events');
    const { Readable, Writable } = require('stream');
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdin = new Writable({ write(_chunk: any, _enc: any, cb: () => void) { cb(); } });
      proc.stdin.on('error', () => {});
      proc.stdout = new Readable({ read() { this.push(null); } });
      proc.stderr = new Readable({ read() { this.push(null); } });
      proc.kill = vi.fn();
      setTimeout(() => proc.emit('close', 1), 10);
      return proc;
    });

    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const };
    await expect(backend.synthesize('Hello world', voice)).rejects.toThrow('Piper exited with code 1');
  });

  it('rejects on non-zero exit even with partial output', async () => {
    const { EventEmitter } = require('events');
    const { Readable, Writable } = require('stream');
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdin = new Writable({ write(_chunk: any, _enc: any, cb: () => void) { cb(); } });
      proc.stdin.on('error', () => {});
      proc.stdout = new Readable({
        read() {
          this.push(Buffer.alloc(1000)); // partial output
          this.push(null);
        },
      });
      proc.stderr = new Readable({ read() { this.push(null); } });
      proc.kill = vi.fn();
      // Emit close with non-zero code after stdout has data
      setTimeout(() => proc.emit('close', 1), 10);
      return proc;
    });

    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const };
    await expect(backend.synthesize('Hello world', voice)).rejects.toThrow('Piper exited with code 1');
  });

  it('rejects on synthesis timeout', async () => {
    vi.useFakeTimers();
    const { EventEmitter } = require('events');
    const { Readable, Writable } = require('stream');
    let mockKill: ReturnType<typeof vi.fn>;
    mockSpawn.mockImplementationOnce(() => {
      const proc = new EventEmitter();
      proc.stdin = new Writable({ write(_chunk: any, _enc: any, cb: () => void) { cb(); } });
      proc.stdin.on('error', () => {});
      proc.stdout = new Readable({ read() { /* never pushes data, never ends */ } });
      proc.stderr = new Readable({ read() { this.push(null); } });
      mockKill = vi.fn();
      proc.kill = mockKill;
      // Process never closes — simulates a hang
      return proc;
    });

    const voice = { voiceId: 'en_US-lessac-medium', voiceName: 'Lessac', backend: 'piper-local' as const };

    // Attach a catch handler immediately to avoid unhandled rejection
    const promise = backend.synthesize('Hello world', voice).catch((err: Error) => err);

    // Advance time past the 60s timeout
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('Piper synthesis timed out after 60s');
    expect(mockKill!).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('dispose is callable', () => {
    expect(() => backend.dispose()).not.toThrow();
  });
});
