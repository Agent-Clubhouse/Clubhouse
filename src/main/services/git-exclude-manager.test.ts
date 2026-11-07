import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs/promises', () => ({
  stat: vi.fn(() => Promise.resolve({ isFile: () => false })),
  readFile: vi.fn(() => Promise.resolve('')),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
  rename: vi.fn(() => Promise.resolve(undefined)),
  rm: vi.fn(() => Promise.resolve(undefined)),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
}));

import * as fsp from 'fs/promises';
import { addExclusions, removeExclusions, replaceExclusions } from './git-exclude-manager';

function normalizedPath(value: unknown): string {
  return String(value).replaceAll('\\', '/');
}

describe('git-exclude-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsp.stat).mockResolvedValue({ isFile: () => false } as any);
  });

  const written = (call = 0) => vi.mocked(fsp.writeFile).mock.calls[call][1] as string;

  describe('addExclusions', () => {
    it('adds the patterns in a block of their own, one pattern per line', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('');

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      expect(fsp.writeFile).toHaveBeenCalledTimes(1);
      expect(written()).toBe('# >>> clubhouse-mode\nCLAUDE.md\n.mcp.json\n# <<< clubhouse-mode\n');
      expect(fsp.rename).toHaveBeenCalledTimes(1);
      const [tempPath, excludePath] = vi.mocked(fsp.rename).mock.calls[0];
      expect(normalizedPath(tempPath)).toContain('.tmp.');
      expect(normalizedPath(excludePath)).toContain('.git/info/exclude');
    });

    it('appends to existing exclude file content', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# existing\n*.log\n');

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(written()).toBe('# existing\n*.log\n# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\n');
    });

    it('keeps what the block lists and adds only new patterns', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\n');

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md', '.mcp.json']);

      expect(written()).toBe('# >>> clubhouse-mode\nCLAUDE.md\n.mcp.json\n# <<< clubhouse-mode\n');
    });

    it('does nothing when all patterns already present', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\n');

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('replaces lines in the old trailing-tag format, which git never matched', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('*.log\nCLAUDE.md # clubhouse-mode\nkeep # other\n');

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(written()).toBe('*.log\n# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\nkeep # other\n');
    });

    it('creates info directory if needed', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fsp.mkdir).toHaveBeenCalled();
    });

    it('serializes concurrent additions for the same project', async () => {
      let excludeContent = '';
      const tempFiles = new Map<string, string>();
      vi.mocked(fsp.readFile).mockImplementation(async (filePath) => {
        const file = String(filePath);
        return tempFiles.get(file) ?? excludeContent;
      });
      vi.mocked(fsp.writeFile).mockImplementation(async (filePath, content) => {
        tempFiles.set(String(filePath), String(content));
      });
      vi.mocked(fsp.rename).mockImplementation(async (oldPath, newPath) => {
        excludeContent = tempFiles.get(String(oldPath)) ?? '';
        tempFiles.delete(String(oldPath));
        expect(normalizedPath(newPath)).toContain('.git/info/exclude');
      });

      await Promise.all([
        addExclusions('/project', 'first', ['first.txt']),
        addExclusions('/project', 'second', ['second.txt']),
      ]);

      expect(excludeContent).toBe('# >>> first\nfirst.txt\n# <<< first\n# >>> second\nsecond.txt\n# <<< second\n');
    });

    it('removes an existing target before rename on platforms that reject overwrites', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('');
      vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error('EEXIST'), { code: 'EEXIST' }));

      await addExclusions('/project', 'clubhouse-mode', ['CLAUDE.md']);

      expect(fsp.rm).toHaveBeenCalledTimes(1);
      const [removedPath, options] = vi.mocked(fsp.rm).mock.calls[0];
      expect(normalizedPath(removedPath)).toContain('.git/info/exclude');
      expect(options).toEqual({ force: true });
      expect(fsp.rename).toHaveBeenCalledTimes(2);
    });

    it('continues a queued write after an earlier write fails', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('');
      vi.mocked(fsp.writeFile)
        .mockRejectedValueOnce(Object.assign(new Error('disk full'), { code: 'ENOSPC' }))
        .mockResolvedValue(undefined);

      const first = addExclusions('/project', 'first', ['first.txt']);
      const second = addExclusions('/project', 'second', ['second.txt']);

      await expect(first).rejects.toThrow('disk full');
      await expect(second).resolves.toBeUndefined();
      expect(fsp.rename).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeExclusions', () => {
    it('removes the tag\'s block and its old-format lines, leaving the rest', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        '# existing\n*.log\n# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\n.mcp.json # clubhouse-mode\n',
      );

      await removeExclusions('/project', 'clubhouse-mode');

      expect(written()).toBe('# existing\n*.log\n');
    });

    it('handles non-existent exclude file gracefully', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      await removeExclusions('/project', 'clubhouse-mode');

      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('leaves file clean when all lines are removed', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# >>> clubhouse-mode\nCLAUDE.md\n# <<< clubhouse-mode\n');

      await removeExclusions('/project', 'clubhouse-mode');

      expect(written()).toBe('');
    });
  });

  describe('replaceExclusions', () => {
    // fs is mocked, so the project is only a name.
    const project = 'project';

    it('makes the block exactly the patterns, in place, leaving other lines and tags alone', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue(
        '# existing\n# >>> clubhouse-managed-claude-code\nCLAUDE.md\n.mcp.json\n# <<< clubhouse-managed-claude-code\n# >>> other\nx\n# <<< other\n',
      );

      await replaceExclusions(project, 'clubhouse-managed-claude-code', ['/CLAUDE.md', '.mcp.json']);

      expect(written()).toBe('# existing\n# >>> clubhouse-managed-claude-code\n/CLAUDE.md\n.mcp.json\n# <<< clubhouse-managed-claude-code\n# >>> other\nx\n# <<< other\n');
    });

    it('turns old trailing-tag lines into a block where they were', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('top\n/CLAUDE.md # clubhouse-managed-claude-code\n.mcp.json # clubhouse-managed-claude-code\nbottom\n');

      await replaceExclusions(project, 'clubhouse-managed-claude-code', ['.mcp.json']);

      expect(written()).toBe('top\n# >>> clubhouse-managed-claude-code\n.mcp.json\n# <<< clubhouse-managed-claude-code\nbottom\n');
    });

    it('does not touch a longer tag that starts the same', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# >>> clubhouse-managed-claude-code-extra\na\n# <<< clubhouse-managed-claude-code-extra\n');

      await replaceExclusions(project, 'clubhouse-managed-claude-code', ['b']);

      expect(written()).toBe('# >>> clubhouse-managed-claude-code-extra\na\n# <<< clubhouse-managed-claude-code-extra\n# >>> clubhouse-managed-claude-code\nb\n# <<< clubhouse-managed-claude-code\n');
    });

    it('writes nothing when the file already says it, and keeps other CRLF lines as they are', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('# existing\n# >>> t\n.mcp.json\n# <<< t\n');
      await replaceExclusions(project, 't', ['.mcp.json']);
      expect(fsp.writeFile).not.toHaveBeenCalled();

      vi.mocked(fsp.readFile).mockResolvedValue('# existing\r\n# >>> t\r\n.mcp.json\r\n# <<< t\r\n');
      await replaceExclusions(project, 't', ['.mcp.json', 'x']);
      expect(written()).toBe('# existing\r\n# >>> t\n.mcp.json\nx\n# <<< t\n');
    });

    it('creates the file when there is none, and writes nothing for no patterns', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      await replaceExclusions(project, 't', []);
      expect(fsp.writeFile).not.toHaveBeenCalled();

      await replaceExclusions(project, 't', ['.mcp.json']);
      expect(fsp.mkdir).toHaveBeenCalled();
      expect(written()).toBe('# >>> t\n.mcp.json\n# <<< t\n');
    });
  });
});
