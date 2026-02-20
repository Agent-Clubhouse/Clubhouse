import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', () => ({
  statSync: vi.fn(() => ({ isFile: () => false })),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import * as fs from 'fs';
import { addExclusions, removeExclusions } from './git-exclude-manager';

describe('git-exclude-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.statSync).mockReturnValue({ isFile: () => false } as any);
    vi.mocked(fs.existsSync).mockReturnValue(true);
  });

  describe('addExclusions', () => {
    it('adds tagged patterns to empty exclude file', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('');

      addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('CLAUDE.md # clubhouse-mode');
      expect(written).toContain('.mcp.json # clubhouse-mode');
    });

    it('appends to existing exclude file content', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('# existing\n*.log\n');

      addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('# existing\n*.log\n');
      expect(written).toContain('CLAUDE.md # clubhouse-mode');
    });

    it('skips patterns already present', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('CLAUDE.md # clubhouse-mode\n');

      addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toContain('.mcp.json # clubhouse-mode');
      // Should not duplicate the existing entry
      expect(written.split('CLAUDE.md # clubhouse-mode').length).toBe(2); // 1 occurrence
    });

    it('does nothing when all patterns already present', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('CLAUDE.md # clubhouse-mode\n');

      addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('creates info directory if needed', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fs.mkdirSync).toHaveBeenCalled();
    });
  });

  describe('removeExclusions', () => {
    it('removes all lines matching the tag', () => {
      vi.mocked(fs.readFileSync).mockReturnValue(
        '# existing\n*.log\nCLAUDE.md # clubhouse-mode\n.mcp.json # clubhouse-mode\n',
      );

      removeExclusions('/project', 'clubhouse-mode');

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).not.toContain('clubhouse-mode');
      expect(written).toContain('# existing');
      expect(written).toContain('*.log');
    });

    it('handles non-existent exclude file gracefully', () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error('ENOENT'); });

      removeExclusions('/project', 'clubhouse-mode');

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('leaves file clean when all lines are removed', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('CLAUDE.md # clubhouse-mode\n');

      removeExclusions('/project', 'clubhouse-mode');

      const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
      expect(written).toBe('');
    });
  });
});
