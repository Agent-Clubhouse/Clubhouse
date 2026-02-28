import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { getShellEnvironment, getDefaultShell, invalidateShellEnvironmentCache } from './shell';
import { execSync } from 'child_process';

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
