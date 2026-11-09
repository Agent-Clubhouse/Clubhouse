import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/Users/testuser';
      return '/tmp';
    }),
  },
}));

vi.mock('./project-store', () => ({
  list: vi.fn(async () => []),
}));

vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import { isPathAllowed, getAllowedRoots, assertAllowedPath } from './path-sandbox';
import * as projectStore from './project-store';
import { app } from 'electron';
import { appLog } from './log-service';

describe('path-sandbox', () => {
  beforeEach(() => {
    vi.mocked(projectStore.list).mockResolvedValue([
      { id: 'proj_1', name: 'my-app', path: '/Users/testuser/projects/my-app' },
      { id: 'proj_2', name: 'other', path: '/Users/testuser/projects/other' },
    ] as any);
    vi.mocked(app.getPath).mockReturnValue('/Users/testuser');
  });

  describe('isPathAllowed', () => {
    const roots = ['/Users/testuser/projects/my-app', '/Users/testuser/.clubhouse-dev'];

    it('allows exact root match', () => {
      expect(isPathAllowed('/Users/testuser/projects/my-app', roots)).toBe(true);
    });

    it('allows paths under a root', () => {
      expect(isPathAllowed('/Users/testuser/projects/my-app/src/index.ts', roots)).toBe(true);
    });

    it('allows nested subdirectories', () => {
      expect(isPathAllowed('/Users/testuser/projects/my-app/src/deep/nested/file.ts', roots)).toBe(true);
    });

    it('allows app data directory paths', () => {
      expect(isPathAllowed('/Users/testuser/.clubhouse-dev/projects.json', roots)).toBe(true);
    });

    it('rejects paths outside all roots', () => {
      expect(isPathAllowed('/etc/passwd', roots)).toBe(false);
    });

    it('rejects home directory SSH keys', () => {
      expect(isPathAllowed('/Users/testuser/.ssh/id_rsa', roots)).toBe(false);
    });

    it('rejects AWS credentials', () => {
      expect(isPathAllowed('/Users/testuser/.aws/credentials', roots)).toBe(false);
    });

    it('blocks path traversal with ..', () => {
      expect(isPathAllowed('/Users/testuser/projects/my-app/../../.ssh/id_rsa', roots)).toBe(false);
    });

    it('blocks prefix attacks (e.g. /my-app-evil when /my-app is allowed)', () => {
      expect(isPathAllowed('/Users/testuser/projects/my-app-evil/file.ts', roots)).toBe(false);
    });

    it('rejects the parent of a root', () => {
      expect(isPathAllowed('/Users/testuser/projects', roots)).toBe(false);
    });

    it('rejects root path', () => {
      expect(isPathAllowed('/', roots)).toBe(false);
    });

    it('returns false when no roots are provided', () => {
      expect(isPathAllowed('/any/path', [])).toBe(false);
    });
  });

  describe('getAllowedRoots', () => {
    it('includes all project paths', async () => {
      const roots = await getAllowedRoots();
      expect(roots).toContain(path.resolve('/Users/testuser/projects/my-app'));
      expect(roots).toContain(path.resolve('/Users/testuser/projects/other'));
    });

    it('includes app data directory (dev mode)', async () => {
      const roots = await getAllowedRoots();
      expect(roots).toContain(path.resolve('/Users/testuser/.clubhouse-dev'));
    });

    it('includes app data directory (packaged mode)', async () => {
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      try {
        const roots = await getAllowedRoots();
        expect(roots).toContain(path.resolve('/Users/testuser/.clubhouse'));
      } finally {
        Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
      }
    });

    it('returns only app data dir when no projects exist', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([]);
      const roots = await getAllowedRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(path.resolve('/Users/testuser/.clubhouse-dev'));
    });
  });

  describe('assertAllowedPath', () => {
    it('does not throw for paths within a project directory', async () => {
      await expect(assertAllowedPath('/Users/testuser/projects/my-app/src/file.ts')).resolves.toBeUndefined();
    });

    it('does not throw for paths within the app data directory', async () => {
      await expect(assertAllowedPath('/Users/testuser/.clubhouse-dev/projects.json')).resolves.toBeUndefined();
    });

    it('throws for paths outside allowed directories', async () => {
      await expect(assertAllowedPath('/etc/passwd')).rejects.toThrow('Access denied');
    });

    it('throws for home directory sensitive files', async () => {
      await expect(assertAllowedPath('/Users/testuser/.ssh/id_rsa')).rejects.toThrow('Access denied');
    });

    it('throws for path traversal attempts', async () => {
      await expect(
        assertAllowedPath('/Users/testuser/projects/my-app/../../.ssh/id_rsa'),
      ).rejects.toThrow('Access denied');
    });

    it('logs blocked attempts', async () => {
      try {
        await assertAllowedPath('/etc/passwd');
      } catch {
        // expected
      }
      expect(appLog).toHaveBeenCalledWith(
        'core:file',
        'error',
        'Path access denied: outside allowed directories',
        expect.objectContaining({
          meta: expect.objectContaining({ targetPath: '/etc/passwd' }),
        }),
      );
    });

    it('includes resolved path in error message', async () => {
      await expect(assertAllowedPath('/Users/testuser/projects/my-app/../../.ssh/id_rsa')).rejects.toThrow(
        path.resolve('/Users/testuser/.ssh/id_rsa'),
      );
    });
  });
});

describe('a write can\'t escape through a symlink (#3177)', () => {
  // Real folders: a project, and a place outside every root.
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'path-sandbox-')));
  const project = path.join(tmp, 'project');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, 'a', 'b', 'c'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
  /** A link, or false where this platform won't make one without privileges. */
  const link = (target: string, at: string, type?: 'junction') => { try { fs.symlinkSync(target, at, type); return true; } catch { return false; } };
  // File links need a privilege on Windows: those cases are skipped there, and show as skipped.
  const fileLinks = link(path.join(outside, 'planted.txt'), path.join(project, 'innocent.txt'));
  link(path.join(outside, 'not', 'yet', 'here.txt'), path.join(project, 'deep.txt'));
  link(path.join(project, 'innocent.txt'), path.join(project, 'chain.txt'));
  link(path.join(project, 'src', 'later.ts'), path.join(project, 'inward.ts'));
  link('loop-b', path.join(project, 'loop-a'));
  link('loop-a', path.join(project, 'loop-b'));
  // Folder links work as junctions on Windows, with no privilege.
  const dirLink = link(outside, path.join(project, 'docs'), 'junction');
  link(path.join(outside, 'deep'), path.join(project, 'L'), 'junction');
  const projectLink = path.join(tmp, 'project-link');
  const linkedProject = link(project, projectLink, 'junction');
  // Relative links, as a repository would carry them.
  const relative = link('../../..', path.join(project, 'a', 'b', 'c', 's'));
  link('../escaped.txt', path.join(project, 'x'));
  // The target as written, not normalised: L/.. must be left for the OS to follow.
  link(`L${path.sep}..${path.sep}b.txt`, path.join(project, 'B'));

  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  beforeEach(() => {
    vi.mocked(projectStore.list).mockResolvedValue([{ id: 'p', name: 'project', path: project }] as Awaited<ReturnType<typeof projectStore.list>>);
    vi.mocked(app.getPath).mockReturnValue(path.join(tmp, 'home'));
  });

  const refused = (p: string, options?: { linkItself?: boolean }) => expect(assertAllowedPath(p, options)).rejects.toThrow(/outside allowed project directories/);
  const allowed = (p: string, options?: { linkItself?: boolean }) => expect(assertAllowedPath(p, options)).resolves.toBeUndefined();

  it.skipIf(!fileLinks)('refuses a dangling link inside the project that points outside it, into folders that don\'t exist yet, or through a chain', async () => {
    await refused(path.join(project, 'innocent.txt'));
    await refused(path.join(project, 'deep.txt'));
    await refused(path.join(project, 'chain.txt'));
  });

  it.skipIf(!dirLink)('refuses a new file under a folder that links outside the project', async () => {
    await refused(path.join(project, 'docs', 'new-file.txt'));
    await refused(path.join(project, 'docs', 'a', 'b', 'c.txt'));
  });

  it.skipIf(!dirLink || process.platform === 'win32')('follows a link before the `..` after it, as the OS does', async () => {
    // project/L is outside/deep, so L/.. is outside, not the project.
    await refused(`${project}/L/../a.txt`);
  });

  it.skipIf(!fileLinks || !relative)('takes a link\'s relative target from where the link really is, and a `..` inside one after a link', async () => {
    // a/b/c/s is the project itself, so s/x is project/x, whose target ../escaped.txt is beside the project.
    await refused(path.join(project, 'a', 'b', 'c', 's', 'x'));
    // B points at L/../b.txt: L is outside/deep, so that is outside/b.txt.
    await refused(path.join(project, 'B'));
  });

  it.skipIf(!fileLinks)('refuses a loop of links rather than guessing', async () => {
    await refused(path.join(project, 'loop-a'));
  });

  it.skipIf(!fileLinks)('a delete or rename acts on the link itself, so a dangling one inside the project may go', async () => {
    await allowed(path.join(project, 'innocent.txt'), { linkItself: true });
    await refused(path.join(project, 'innocent.txt'));
  });

  it('allows new files in the project, and a project registered through a link', async () => {
    await allowed(path.join(project, 'src', 'new.ts'));
    await allowed(path.join(project, 'new-dir', 'x', 'y.ts'));
    if (fileLinks) await allowed(path.join(project, 'inward.ts'));
    if (linkedProject) {
      vi.mocked(projectStore.list).mockResolvedValue([{ id: 'p', name: 'project', path: projectLink }] as Awaited<ReturnType<typeof projectStore.list>>);
      await allowed(path.join(projectLink, 'src', 'new.ts'));
      await allowed(path.join(project, 'src', 'new.ts'));
    }
  });
});
