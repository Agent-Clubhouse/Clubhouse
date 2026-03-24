import * as path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const MOCK_HOME = '/mock-home';

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => MOCK_HOME),
  },
}));

// Mock fs/promises
vi.mock('fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  rm: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    if (cb) cb(null, { stdout: '', stderr: '' });
    return { on: vi.fn(), stdout: null, stderr: null };
  }),
}));

// Mock log-service
vi.mock('./log-service', () => ({
  appLog: vi.fn(),
}));

import * as fs from 'fs/promises';
import {
  getCompanionWorkspacePath,
  workspaceExists,
  ensureCompanionWorkspace,
  removeCompanionWorkspace,
} from './companion-workspace';

/** Build expected path using path.join so it matches on all platforms. */
function expectedPath(pluginId: string): string {
  return path.join(MOCK_HOME, '.clubhouse', 'plugin-workspaces', pluginId);
}

describe('companion-workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCompanionWorkspacePath', () => {
    it('returns path under ~/.clubhouse/plugin-workspaces/', () => {
      const result = getCompanionWorkspacePath('daily-admin');
      expect(result).toBe(expectedPath('daily-admin'));
    });
  });

  describe('workspaceExists', () => {
    it('returns true when directory exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      expect(await workspaceExists('daily-admin')).toBe(true);
    });

    it('returns false when directory does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      expect(await workspaceExists('daily-admin')).toBe(false);
    });
  });

  describe('ensureCompanionWorkspace', () => {
    it('creates directory and returns path when workspace does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const result = await ensureCompanionWorkspace('daily-admin');
      expect(result).toBe(expectedPath('daily-admin'));
      expect(fs.mkdir).toHaveBeenCalledWith(
        expectedPath('daily-admin'),
        { recursive: true },
      );
    });

    it('returns path without creating when workspace already exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);

      const result = await ensureCompanionWorkspace('daily-admin');
      expect(result).toBe(expectedPath('daily-admin'));
      expect(fs.mkdir).not.toHaveBeenCalled();
    });
  });

  describe('removeCompanionWorkspace', () => {
    it('removes directory when it exists', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined);
      vi.mocked(fs.rm).mockResolvedValue(undefined);

      const result = await removeCompanionWorkspace('daily-admin');
      expect(result).toBe(true);
      expect(fs.rm).toHaveBeenCalledWith(
        expectedPath('daily-admin'),
        { recursive: true, force: true },
      );
    });

    it('returns false when workspace does not exist', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('ENOENT'));

      const result = await removeCompanionWorkspace('daily-admin');
      expect(result).toBe(false);
      expect(fs.rm).not.toHaveBeenCalled();
    });
  });
});
