import { describe, it, expect, beforeEach, vi } from 'vitest';
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
  list: vi.fn(() => []),
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
    vi.mocked(projectStore.list).mockReturnValue([
      { id: 'proj_1', name: 'my-app', path: '/Users/testuser/projects/my-app' },
      { id: 'proj_2', name: 'other', path: '/Users/testuser/projects/other' },
    ]);
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
    it('includes all project paths', () => {
      const roots = getAllowedRoots();
      expect(roots).toContain(path.resolve('/Users/testuser/projects/my-app'));
      expect(roots).toContain(path.resolve('/Users/testuser/projects/other'));
    });

    it('includes app data directory (dev mode)', () => {
      const roots = getAllowedRoots();
      expect(roots).toContain(path.resolve('/Users/testuser/.clubhouse-dev'));
    });

    it('includes app data directory (packaged mode)', () => {
      Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
      try {
        const roots = getAllowedRoots();
        expect(roots).toContain(path.resolve('/Users/testuser/.clubhouse'));
      } finally {
        Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
      }
    });

    it('returns only app data dir when no projects exist', () => {
      vi.mocked(projectStore.list).mockReturnValue([]);
      const roots = getAllowedRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toBe(path.resolve('/Users/testuser/.clubhouse-dev'));
    });
  });

  describe('assertAllowedPath', () => {
    it('does not throw for paths within a project directory', () => {
      expect(() => assertAllowedPath('/Users/testuser/projects/my-app/src/file.ts')).not.toThrow();
    });

    it('does not throw for paths within the app data directory', () => {
      expect(() => assertAllowedPath('/Users/testuser/.clubhouse-dev/projects.json')).not.toThrow();
    });

    it('throws for paths outside allowed directories', () => {
      expect(() => assertAllowedPath('/etc/passwd')).toThrow('Access denied');
    });

    it('throws for home directory sensitive files', () => {
      expect(() => assertAllowedPath('/Users/testuser/.ssh/id_rsa')).toThrow('Access denied');
    });

    it('throws for path traversal attempts', () => {
      expect(() =>
        assertAllowedPath('/Users/testuser/projects/my-app/../../.ssh/id_rsa'),
      ).toThrow('Access denied');
    });

    it('logs blocked attempts', () => {
      try {
        assertAllowedPath('/etc/passwd');
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

    it('includes resolved path in error message', () => {
      expect(() => assertAllowedPath('/Users/testuser/projects/my-app/../../.ssh/id_rsa')).toThrow(
        path.resolve('/Users/testuser/.ssh/id_rsa'),
      );
    });
  });
});
