import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import { getShellEnvironment, getDefaultShell, invalidateShellEnvironmentCache, preWarmShellEnvironment } from './shell';
import { execSync, execFile } from 'child_process';

// The module caches the shell env, so we need to reset between tests
// by re-importing. Since that's complex, we test cumulative behavior.

describe('getShellEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with PATH merged from shell output', () => {
    vi.mocked(execSync).mockImplementation(() => 'PATH=/usr/local/bin:/usr/bin\nHOME=/home/user\n');
    const env = getShellEnvironment();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
    // Should include keys from process.env and shell output
    expect(env).toHaveProperty('PATH');
    expect(env).toHaveProperty('HOME');
  });

  it('caches the result on subsequent calls', () => {
    vi.mocked(execSync).mockImplementation(() => 'PATH=/usr/bin\n');
    const env1 = getShellEnvironment();
    const env2 = getShellEnvironment();
    // Should be the same reference due to caching
    expect(env1).toBe(env2);
  });
});

describe('invalidateShellEnvironmentCache', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    // Force non-Windows so the execSync code path is exercised
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('causes getShellEnvironment to re-source on next call', () => {
    // Clear any cache left from prior tests
    invalidateShellEnvironmentCache();

    vi.mocked(execSync).mockImplementation(() => 'FOO=bar\n');
    const env1 = getShellEnvironment();
    expect(env1.FOO).toBe('bar');

    // Simulate the user adding a new env var
    vi.mocked(execSync).mockImplementation(() => 'FOO=bar\nNEW_KEY=new_value\n');
    invalidateShellEnvironmentCache();

    const env2 = getShellEnvironment();
    expect(env2.NEW_KEY).toBe('new_value');
    // Should be a different reference since cache was invalidated
    expect(env1).not.toBe(env2);
  });
});

describe('getDefaultShell', () => {
  const originalPlatform = process.platform;
  const originalSHELL = process.env.SHELL;
  const originalCOMSPEC = process.env.COMSPEC;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env.SHELL = originalSHELL;
    process.env.COMSPEC = originalCOMSPEC;
  });

  it('returns SHELL env var on non-Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/bin/bash';
    expect(getDefaultShell()).toBe('/bin/bash');
  });

  it('falls back to /bin/zsh on non-Windows when SHELL is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    expect(getDefaultShell()).toBe('/bin/zsh');
  });

  it('returns COMSPEC env var on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    expect(getDefaultShell()).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  it('falls back to cmd.exe on Windows when COMSPEC is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.COMSPEC;
    expect(getDefaultShell()).toBe('cmd.exe');
  });
});

describe('preWarmShellEnvironment', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    invalidateShellEnvironmentCache();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('calls execFile asynchronously to resolve shell env', () => {
    preWarmShellEnvironment();
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      expect.any(String),
      ['-ilc', 'env'],
      expect.objectContaining({ encoding: 'utf-8', timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('populates cache when async callback fires', () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(null, 'WARM_KEY=warm_value\n', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    expect(env.WARM_KEY).toBe('warm_value');
  });

  it('does not overwrite cache if getShellEnvironment was called first', () => {
    // Simulate: sync getShellEnvironment runs before async callback
    vi.mocked(execSync).mockImplementation(() => 'SYNC_KEY=sync_value\n');
    getShellEnvironment(); // populates cache synchronously

    // Now pre-warm fires — should not overwrite
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(null, 'ASYNC_KEY=async_value\n', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    expect(env.SYNC_KEY).toBe('sync_value');
    // ASYNC_KEY should NOT be present since cache was already populated
    expect(env.ASYNC_KEY).toBeUndefined();
  });

  it('falls back to process.env on error', () => {
    vi.mocked(execFile).mockImplementation(
      (_cmd: string, _args: string[], _opts: any, cb?: any) => {
        if (cb) cb(new Error('shell failed'), '', '');
        return {} as any;
      },
    );

    preWarmShellEnvironment();

    const env = getShellEnvironment();
    // Should have process.env entries
    expect(env).toBeDefined();
    expect(typeof env.PATH).toBe('string');
  });

  it('is a no-op on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    preWarmShellEnvironment();
    // Should not call execFile on Windows
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
    // But cache should be populated with process.env
    const env = getShellEnvironment();
    expect(env).toBeDefined();
  });
});
