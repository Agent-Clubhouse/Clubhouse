import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  stat: vi.fn(() => Promise.resolve({ isFile: () => false })),
  readFile: vi.fn(() => Promise.resolve('')),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
}));

import * as fsp from 'fs/promises';
import { addExclusions, removeExclusions } from './git-exclude-manager';

describe('git-exclude-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.stat).mockResolvedValue({ isFile: () => false } as any);
  });

  describe('addExclusions', () => {
    it('adds tagged patterns to empty exclude file', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('CLAUDE.md # clubhouse-mode');
      expect(written).toContain('.mcp.json # clubhouse-mode');
    });

    it('appends to existing exclude file content', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# existing\n*.log\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('# existing\n*.log\n');
      expect(written).toContain('CLAUDE.md # clubhouse-mode');
    });

    it('skips patterns already present', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('CLAUDE.md # clubhouse-mode\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toContain('.mcp.json # clubhouse-mode');
      expect(written.split('CLAUDE.md # clubhouse-mode').length).toBe(2);
    });

    it('does nothing when all patterns already present', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('CLAUDE.md # clubhouse-mode\n');
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('creates info directory if needed', async () => {
      vi.mocked(fsp.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fsp.mkdir).toHaveBeenCalled();
    });
  });

  describe('removeExclusions', () => {
    it('removes all lines matching the tag', async () => {
      vi.mocked(fsp.stat).mockResolvedValue({ isFile: () => false } as any);
      vi.mocked(fsp.readFile).mockResolvedValue(
        '# existing\n*.log\nCLAUDE.md # clubhouse-mode\n.mcp.json # clubhouse-mode\n',
      );
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await removeExclusions('/project', 'clubhouse-mode');

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).not.toContain('clubhouse-mode');
      expect(written).toContain('# existing');
      expect(written).toContain('*.log');
    });

    it('handles non-existent exclude file gracefully', async () => {
      vi.mocked(fsp.stat).mockResolvedValue({ isFile: () => false } as any);
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await removeExclusions('/project', 'clubhouse-mode');

      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('leaves file clean when all lines are removed', async () => {
      vi.mocked(fsp.stat).mockResolvedValue({ isFile: () => false } as any);
      vi.mocked(fsp.readFile).mockResolvedValue('CLAUDE.md # clubhouse-mode\n');
      vi.mocked(fsp.writeFile).mockResolvedValue(undefined);

      await removeExclusions('/project', 'clubhouse-mode');

      const written = vi.mocked(fsp.writeFile).mock.calls[0][1] as string;
      expect(written).toBe('');
    });
  });
});
