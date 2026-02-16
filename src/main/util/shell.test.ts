import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// getShellEnvironment is the only export now
import { getShellEnvironment } from './shell';
import { execSync } from 'child_process';

describe('getShellEnvironment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an environment object', () => {
    vi.mocked(execSync).mockImplementation(() => 'PATH=/usr/bin\nHOME=/tmp\n');
    const env = getShellEnvironment();
    expect(env).toBeDefined();
    expect(typeof env).toBe('object');
  });
});
