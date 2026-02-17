import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => { throw new Error('not found'); }),
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(new Error('not found'), { stdout: '', stderr: '' });
    return { stdout: '', stderr: '' };
  }),
}));

vi.mock('../util/shell', () => ({
  getShellEnvironment: vi.fn(() => ({ PATH: '/usr/local/bin:/usr/bin' })),
}));

import * as fs from 'fs';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CopilotCliProvider } from './copilot-cli-provider';
import { OpenCodeProvider } from './opencode-provider';

describe('Instructions path resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: binaries found at standard paths
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('/claude') || s.endsWith('/copilot') || s.endsWith('/opencode');
    });
  });

  describe('ClaudeCodeProvider', () => {
    let provider: ClaudeCodeProvider;

    beforeEach(() => {
      provider = new ClaudeCodeProvider();
    });

    it('reads CLAUDE.md at project root', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('project instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('project instructions');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', 'CLAUDE.md'),
        'utf-8'
      );
    });

    it('returns empty string when file does not exist', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = provider.readInstructions('/project');
      expect(result).toBe('');
    });

    it('writes CLAUDE.md at project root', () => {
      provider.writeInstructions('/project', 'new instructions');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', 'CLAUDE.md'),
        'new instructions',
        'utf-8'
      );
    });

    it('does not write to .claude/CLAUDE.local.md', () => {
      provider.writeInstructions('/project', 'test');

      const writePath = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;
      expect(writePath).not.toContain('CLAUDE.local.md');
      expect(writePath).not.toContain('.claude');
    });

    it('round-trip: write then read returns same content', () => {
      const content = 'My custom instructions\nWith multiple lines';
      provider.writeInstructions('/project', content);

      vi.mocked(fs.readFileSync).mockReturnValue(content);
      const result = provider.readInstructions('/project');
      expect(result).toBe(content);
    });
  });

  describe('CopilotCliProvider', () => {
    let provider: CopilotCliProvider;

    beforeEach(() => {
      provider = new CopilotCliProvider();
    });

    it('reads from .github/copilot-instructions.md', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('copilot instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('copilot instructions');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'utf-8'
      );
    });

    it('writes to .github/copilot-instructions.md', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/copilot') || s.includes('.github');
      });

      provider.writeInstructions('/project', 'new copilot instructions');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'new copilot instructions',
        'utf-8'
      );
    });

    it('returns empty string when file missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(provider.readInstructions('/project')).toBe('');
    });
  });

  describe('OpenCodeProvider', () => {
    let provider: OpenCodeProvider;

    beforeEach(() => {
      provider = new OpenCodeProvider();
    });

    it('reads from .opencode/instructions.md', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('opencode instructions');
      const result = provider.readInstructions('/project');
      expect(result).toBe('opencode instructions');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.opencode', 'instructions.md'),
        'utf-8'
      );
    });

    it('writes to .opencode/instructions.md', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/opencode') || s.includes('.opencode');
      });

      provider.writeInstructions('/project', 'new opencode instructions');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.opencode', 'instructions.md'),
        'new opencode instructions',
        'utf-8'
      );
    });

    it('returns empty string when file missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      expect(provider.readInstructions('/project')).toBe('');
    });
  });
});
