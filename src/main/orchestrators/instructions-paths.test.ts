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

    it('reads .claude/CLAUDE.local.md first', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('local content');
      const result = provider.readInstructions('/project');
      expect(result).toBe('local content');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        path.join('/project', '.claude', 'CLAUDE.local.md'),
        'utf-8'
      );
    });

    it('falls back to CLAUDE.md when .claude/CLAUDE.local.md missing', () => {
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('CLAUDE.local.md')) throw new Error('ENOENT');
        return 'legacy content';
      });
      const result = provider.readInstructions('/project');
      expect(result).toBe('legacy content');
    });

    it('returns empty string when neither file exists', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
      const result = provider.readInstructions('/project');
      expect(result).toBe('');
    });

    it('writes to .claude/CLAUDE.local.md', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const s = String(p);
        return s.endsWith('/claude') || s.includes('.claude');
      });

      provider.writeInstructions('/project', 'new instructions');

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join('/project', '.claude', 'CLAUDE.local.md'),
        'new instructions',
        'utf-8'
      );
    });

    it('creates .claude/ directory if missing', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      provider.writeInstructions('/project', 'content');

      expect(fs.mkdirSync).toHaveBeenCalledWith(
        path.join('/project', '.claude'),
        { recursive: true }
      );
    });

    it('verifies correct file casing (uppercase CLAUDE.local.md)', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));
      provider.writeInstructions('/project', 'test');

      const writePath = vi.mocked(fs.writeFileSync).mock.calls[0][0] as string;
      expect(writePath).toContain('CLAUDE.local.md');
      expect(writePath).not.toContain('claude.local.md');
    });

    it('round-trip: write then read returns same content', () => {
      vi.mocked(fs.existsSync).mockImplementation((p) => String(p).endsWith('/claude'));

      const content = 'My custom instructions\nWith multiple lines';
      provider.writeInstructions('/project', content);

      // Simulate reading back what was written
      vi.mocked(fs.readFileSync).mockReturnValue(content);
      const result = provider.readInstructions('/project');
      expect(result).toBe(content);
    });

    it('precedence: .claude/CLAUDE.local.md wins over CLAUDE.md', () => {
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p).includes('CLAUDE.local.md')) return 'local wins';
        return 'legacy loses';
      });
      const result = provider.readInstructions('/project');
      expect(result).toBe('local wins');
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
