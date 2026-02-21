import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-clubhouse' },
}));

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => p.includes('whisper')),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
}));

import { BinaryManager } from './binary-manager';

describe('BinaryManager', () => {
  let manager: BinaryManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BinaryManager();
  });

  it('returns correct binary path for whisper-cpp', () => {
    const p = manager.getBinaryPath('whisper-cpp');
    expect(p).toContain('whisper-cpp');
    expect(p).toContain('audio');
  });

  it('returns correct binary path for piper', () => {
    const p = manager.getBinaryPath('piper');
    expect(p).toContain('piper');
    expect(p).toContain('audio');
  });

  it('returns correct binary path for parakeet', () => {
    const p = manager.getBinaryPath('parakeet');
    expect(p).toContain('parakeet');
    expect(p).toContain('audio');
  });

  it('isInstalled returns true when binary exists', async () => {
    expect(await manager.isInstalled('whisper-cpp')).toBe(true);
  });

  it('isInstalled returns false when binary missing', async () => {
    expect(await manager.isInstalled('piper')).toBe(false);
  });

  it('install creates directory and reports progress', async () => {
    const fs = await import('fs');
    const onProgress = vi.fn();
    await manager.install('whisper-cpp', onProgress);
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('whisper-cpp'),
      { recursive: true },
    );
    expect(onProgress).toHaveBeenCalledWith(100);
  });

});
