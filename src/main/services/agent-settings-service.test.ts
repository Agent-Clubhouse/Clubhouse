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

  it('reads from .claude/CLAUDE.local.md when available', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('CLAUDE.local.md')) return '# Local content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('# Local content');
    expect(vi.mocked(fs.readFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'CLAUDE.local.md'),
      'utf-8',
    );
  });

  it('falls back to CLAUDE.md when .claude/CLAUDE.local.md does not exist', () => {
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (String(p).endsWith('CLAUDE.local.md')) throw new Error('not found');
      if (String(p).endsWith('CLAUDE.md')) return '# Legacy content';
      throw new Error('not found');
    });

    const result = readClaudeMd(WORKTREE);
    expect(result).toBe('# Legacy content');
  });

  it('returns empty string when neither file exists', () => {
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

  it('writes to .claude/CLAUDE.local.md', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    writeClaudeMd(WORKTREE, '# New content');
    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude', 'CLAUDE.local.md'),
      '# New content',
      'utf-8',
    );
  });

  it('creates .claude directory if missing', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    writeClaudeMd(WORKTREE, '# Content');
    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      path.join(WORKTREE, '.claude'),
      { recursive: true },
    );
  });
});
