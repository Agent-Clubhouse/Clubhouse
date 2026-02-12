import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

import * as fs from 'fs';
import { execSync } from 'child_process';
import { findClaudeBinary } from './shell';

describe('findClaudeBinary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns first existing common path', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      return String(p) === '/usr/local/bin/claude';
    });
    expect(findClaudeBinary()).toBe('/usr/local/bin/claude');
  });

  it('falls back to which when no common path', () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      // Common paths don't exist, but which result does
      if (String(p) === '/custom/bin/claude') return true;
      return false;
    });
    vi.mocked(execSync).mockReturnValue('/custom/bin/claude\n');
    expect(findClaudeBinary()).toBe('/custom/bin/claude');
  });

  it('throws descriptive error when not found anywhere', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
    expect(() => findClaudeBinary()).toThrow('Could not find the claude CLI binary');
  });
});
