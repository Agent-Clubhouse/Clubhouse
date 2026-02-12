import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

// electron is aliased to our mock via vitest.config.ts
// app.getPath('home') returns '/tmp/clubhouse-test-home'

import * as fs from 'fs';
import { execSync } from 'child_process';
import { findClaudeBinary } from './shell';

const TEST_HOME = '/tmp/clubhouse-test-home';

describe('findClaudeBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns first existing common path', () => {
    const expectedPath = `${TEST_HOME}/.local/bin/claude`;
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      return String(p) === expectedPath;
    });
    expect(findClaudeBinary()).toBe(expectedPath);
  });

  it('falls back to shell PATH when no common path exists', () => {
    // First call: getShellEnv via execSync for `env`
    // Subsequent calls: existsSync checks
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('env')) return 'PATH=/custom/bin\n';
      throw new Error('not found');
    });
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // Common paths don't exist, but PATH-resolved candidate does
      if (String(p) === '/custom/bin/claude') return true;
      return false;
    });
    expect(findClaudeBinary()).toBe('/custom/bin/claude');
  });

  it('throws descriptive error when not found anywhere', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    expect(() => findClaudeBinary()).toThrow('Could not find the claude CLI binary');
  });
});
