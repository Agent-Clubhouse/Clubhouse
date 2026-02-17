import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
}));

import * as fs from 'fs';
import { readClaudeMd, writeClaudeMd } from './agent-settings-service';

const WORKTREE = '/test/worktree';

describe('readClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads from CLAUDE.md at project root', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p) === path.join(WORKTREE, 'CLAUDE.md')) return '# Project content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('# Project content');
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      'utf-8',
    );
  });

  it('does not read from .claude/CLAUDE.local.md', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).includes('CLAUDE.local.md')) return '# Local content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });

  it('returns empty string when file does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('');
  });
});

describe('writeClaudeMd', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes to CLAUDE.md at project root', () => {
    writeClaudeMd(WORKTREE, '# New content');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, 'CLAUDE.md'),
      '# New content',
      'utf-8',
    );
  });

  it('does not create .claude directory', () => {
    writeClaudeMd(WORKTREE, '# Content');
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
  });
});
