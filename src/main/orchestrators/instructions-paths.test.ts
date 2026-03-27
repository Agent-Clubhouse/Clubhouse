import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => { throw new Error('ENOENT'); }),
  writeFile: vi.fn(async () => {}),
  mkdir: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isDirectory: () => true })),
  realpath: vi.fn(async (p: string) => p),
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
import * as fsp from 'fs/promises';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CopilotCliProvider } from './copilot-cli-provider';
import { CodexCliProvider } from './codex-cli-provider';


describe('Instructions path resolution', () => {
  // path.join normalizes separators for cross-platform compat ('\project' on Windows)
  const projectDir = path.join('/project');

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: binaries found at standard paths
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const s = String(p);
      return s.endsWith('/claude') || s.endsWith('/copilot') || s.endsWith('/codex');
    });
  });

  describe('ClaudeCodeProvider', () => {
    let provider: ClaudeCodeProvider;

    beforeEach(() => {
      provider = new ClaudeCodeProvider();
    });

    it('reads CLAUDE.md at project root', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('project instructions');
      const result = await provider.readInstructions('/project');
      expect(result).toBe('project instructions');
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join('/project', 'CLAUDE.md'),
        'utf-8'
      );
    });

    it('returns empty string when file does not exist', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      const result = await provider.readInstructions('/project');
      expect(result).toBe('');
    });

    it('writes CLAUDE.md at project root', async () => {
      await provider.writeInstructions('/project', 'new instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', 'CLAUDE.md'),
        'new instructions',
        'utf-8'
      );
    });

    it('does not write to .claude/CLAUDE.local.md', async () => {
      await provider.writeInstructions('/project', 'test');

      const writePath = vi.mocked(fsp.writeFile).mock.calls[0][0] as string;
      expect(writePath).not.toContain('CLAUDE.local.md');
      expect(writePath).not.toContain('.claude');
    });

    it('round-trip: write then read returns same content', async () => {
      const content = 'My custom instructions\nWith multiple lines';
      await provider.writeInstructions('/project', content);

      vi.mocked(fsp.readFile).mockResolvedValue(content);
      const result = await provider.readInstructions('/project');
      expect(result).toBe(content);
    });
  });

  describe('CopilotCliProvider', () => {
    let provider: CopilotCliProvider;

    beforeEach(() => {
      provider = new CopilotCliProvider();
    });

    it('reads from .github/copilot-instructions.md', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('copilot instructions');
      const result = await provider.readInstructions('/project');
      expect(result).toBe('copilot instructions');
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'utf-8'
      );
    });

    it('writes to .github/copilot-instructions.md', async () => {
      await provider.writeInstructions('/project', 'new copilot instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project', '.github'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', '.github', 'copilot-instructions.md'),
        'new copilot instructions',
        'utf-8'
      );
    });

    it('returns empty string when file missing', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await provider.readInstructions('/project')).toBe('');
    });
  });

  describe('CodexCliProvider', () => {
    let provider: CodexCliProvider;

    beforeEach(() => {
      provider = new CodexCliProvider();
    });

    it('reads from AGENTS.md at project root', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('codex instructions');
      const result = await provider.readInstructions('/project');
      expect(result).toBe('codex instructions');
      expect(fsp.readFile).toHaveBeenCalledWith(
        path.join('/project', 'AGENTS.md'),
        'utf-8'
      );
    });

    it('writes to AGENTS.md at project root', async () => {
      await provider.writeInstructions('/project', 'new codex instructions');

      expect(fsp.mkdir).toHaveBeenCalledWith(
        path.join('/project'),
        { recursive: true }
      );
      expect(fsp.writeFile).toHaveBeenCalledWith(
        path.join('/project', 'AGENTS.md'),
        'new codex instructions',
        'utf-8'
      );
    });

    it('returns empty string when file missing', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      expect(await provider.readInstructions('/project')).toBe('');
    });

    it('round-trip: write then read returns same content', async () => {
      const content = 'Codex-specific instructions\nWith multiple lines';
      await provider.writeInstructions('/project', content);

      vi.mocked(fsp.readFile).mockResolvedValue(content);
      const result = await provider.readInstructions('/project');
      expect(result).toBe(content);
    });
  });

});
