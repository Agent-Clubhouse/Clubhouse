import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => ({})),
  },
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
}));

vi.mock('../services/project-store', () => ({
  list: vi.fn(async () => []),
}));

vi.mock('../services/log-service', () => ({
  appLog: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: vi.fn((p: string) => Promise.resolve(p)),
  stat: vi.fn(),
  unlink: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock('../services/path-sandbox', () => ({
  assertAllowedPath: vi.fn(async () => undefined),
}));

import { ipcMain, dialog } from 'electron';
import * as fsp from 'fs/promises';
import * as projectStore from '../services/project-store';
import { assertAllowedPath } from '../services/path-sandbox';
import { registerBlueprintHandlers } from './blueprint-handlers';

// Extract registered handler from ipcMain.handle mock
function getHandler(channel: string): (...args: unknown[]) => unknown {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const match = calls.find(([ch]: [string]) => ch === channel);
  if (!match) throw new Error(`No handler registered for channel: ${channel}`);
  return match[1] as (...args: unknown[]) => unknown;
}

describe('blueprint-handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all files are small (under the 10 MB limit)
    vi.mocked(fsp.stat).mockResolvedValue({ size: 100 } as any);
    registerBlueprintHandlers();
  });

  describe('BLUEPRINT.LIST', () => {
    it('registers both blueprint IPC handlers', () => {
      const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map(([ch]: [string]) => ch);
      expect(channels).toContain('blueprint:list');
      expect(channels).toContain('blueprint:read');
    });

    it('returns empty array when no projects have blueprints directory', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'test', path: '/tmp/test', displayName: 'Test' } as any,
      ]);
      vi.mocked(fsp.access).mockRejectedValue(new Error('ENOENT'));

      const handler = getHandler('blueprint:list');
      const result = await handler({});
      expect(result).toEqual([]);
    });

    it('scans and parses blueprint JSON files', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'my-project', path: '/tmp/proj', displayName: 'My Project' } as any,
      ]);
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'squad.json', isFile: () => true } as any,
        { name: 'not-json.txt', isFile: () => true } as any,
        { name: 'subdir', isFile: () => false } as any,
      ]);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        version: 1,
        name: 'Squad Setup',
        description: 'A team of agents',
        views: [
          { type: 'agent', title: 'Agent A', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, metadata: {} },
          { type: 'anchor', title: 'Notes', position: { x: 500, y: 0 }, size: { width: 240, height: 50 }, metadata: {} },
        ],
      }));

      const handler = getHandler('blueprint:list');
      const result = await handler({}) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Squad Setup');
      expect(result[0].description).toBe('A team of agents');
      expect(result[0].viewCount).toBe(2);
      expect(result[0].agentCount).toBe(1);
      expect(result[0].wireCount).toBe(0);
      expect(result[0].version).toBe(1);
      expect(result[0].source).toBe('My Project');
    });

    it('handles BlueprintManifest format with nested canvas.views and canvas.wires', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'proj', path: '/tmp/proj', displayName: 'Proj' } as any,
      ]);
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'manifest.json', isFile: () => true } as any,
      ]);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        schemaVersion: 1,
        name: 'Bake-off',
        description: 'Competition blueprint',
        canvas: {
          views: [
            { refId: 'v1', type: 'agent', displayName: 'Alpha' },
            { refId: 'v2', type: 'agent', displayName: 'Beta' },
            { refId: 'v3', type: 'anchor', displayName: 'Hub' },
          ],
          wires: [
            { sourceRef: 'v1', targetRef: 'v3' },
            { sourceRef: 'v2', targetRef: 'v3' },
          ],
        },
        agents: [{ refId: 'a1', name: 'Alpha' }, { refId: 'a2', name: 'Beta' }],
      }));

      const handler = getHandler('blueprint:list');
      const result = await handler({}) as any[];
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Bake-off');
      expect(result[0].viewCount).toBe(3);
      expect(result[0].agentCount).toBe(2);
      expect(result[0].wireCount).toBe(2);
    });

    it('skips invalid JSON files without crashing', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'proj', path: '/tmp/proj', displayName: 'Proj' } as any,
      ]);
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'bad.json', isFile: () => true } as any,
      ]);
      vi.mocked(fsp.readFile).mockResolvedValue('not valid json {{{');

      const handler = getHandler('blueprint:list');
      const result = await handler({}) as any[];
      expect(result).toEqual([]);
    });

    it('skips blueprint files exceeding the 10 MB size limit (SEC-HIGH-06)', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'proj', path: '/tmp/proj', displayName: 'Proj' } as any,
      ]);
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'huge.json', isFile: () => true } as any,
        { name: 'small.json', isFile: () => true } as any,
      ]);
      // First file is oversized, second is small
      vi.mocked(fsp.stat)
        .mockResolvedValueOnce({ size: 11 * 1024 * 1024 } as any)
        .mockResolvedValueOnce({ size: 100 } as any);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({ version: 1, name: 'Small', views: [] }));

      const handler = getHandler('blueprint:list');
      const result = await handler({}) as any[];
      // Only the small file should be returned
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Small');
      // readFile called only once (for the small file, not the huge one)
      expect(fsp.readFile).toHaveBeenCalledTimes(1);
    });

    it('scans multiple projects', async () => {
      vi.mocked(projectStore.list).mockResolvedValue([
        { id: 'p1', name: 'proj-a', path: '/tmp/a', displayName: 'A' } as any,
        { id: 'p2', name: 'proj-b', path: '/tmp/b', displayName: 'B' } as any,
      ]);
      vi.mocked(fsp.access).mockResolvedValue(undefined);
      vi.mocked(fsp.readdir).mockResolvedValue([
        { name: 'bp.json', isFile: () => true } as any,
      ]);
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify({
        version: 1, name: 'Test', views: [],
      }));

      const handler = getHandler('blueprint:list');
      const result = await handler({}) as any[];
      expect(result).toHaveLength(2);
      expect(result[0].source).toBe('A');
      expect(result[1].source).toBe('B');
    });
  });

  describe('BLUEPRINT.READ', () => {
    it('reads and parses a blueprint file by path', async () => {
      const data = { version: 1, name: 'Test', views: [] };
      vi.mocked(fsp.readFile).mockResolvedValue(JSON.stringify(data));

      const handler = getHandler('blueprint:read');
      const result = await handler({}, '/tmp/test.json');
      expect(result).toEqual(data);
    });

    it('returns null for blueprint files exceeding the 10 MB size limit (SEC-HIGH-06)', async () => {
      vi.mocked(fsp.stat).mockResolvedValueOnce({ size: 11 * 1024 * 1024 } as any);

      const handler = getHandler('blueprint:read');
      const result = await handler({}, '/tmp/proj/.clubhouse/blueprints/huge.json');
      expect(result).toBeNull();
      expect(fsp.readFile).not.toHaveBeenCalled();
    });

    it('returns null for missing files', async () => {
      vi.mocked(fsp.readFile).mockRejectedValue(new Error('ENOENT'));

      const handler = getHandler('blueprint:read');
      const result = await handler({}, '/tmp/missing.json');
      expect(result).toBeNull();
    });

    it('calls assertAllowedPath before reading file', async () => {
      vi.mocked(fsp.readFile).mockResolvedValue('{}');
      const handler = getHandler('blueprint:read');
      await handler({}, '/tmp/proj/.clubhouse/blueprints/bp.json');
      expect(assertAllowedPath).toHaveBeenCalledWith('/tmp/proj/.clubhouse/blueprints/bp.json');
    });

    it('rejects reads outside allowed directories', async () => {
      vi.mocked(assertAllowedPath).mockRejectedValueOnce(new Error('Access denied'));

      const handler = getHandler('blueprint:read');
      const result = await handler({}, '/etc/passwd');
      expect(result).toBeNull();
      expect(fsp.readFile).not.toHaveBeenCalled();
    });
  });

  describe('BLUEPRINT.DELETE', () => {
    it('calls assertAllowedPath before deleting', async () => {
      const bp = '/tmp/proj/.clubhouse/blueprints/old.json';
      vi.mocked(fsp.realpath).mockResolvedValueOnce(bp);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, bp);
      expect(assertAllowedPath).toHaveBeenCalledWith(bp);
      expect(result).toBe(true);
    });

    it('rejects deletion outside allowed directories', async () => {
      vi.mocked(assertAllowedPath).mockRejectedValueOnce(new Error('Access denied'));

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, '/etc/important.json');
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('rejects path traversal attempts that resolve outside blueprints dir', async () => {
      vi.mocked(fsp.realpath).mockResolvedValueOnce('/tmp/proj/secret.json');

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, '/tmp/proj/.clubhouse/blueprints/../../secret.json');
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('rejects non-JSON files', async () => {
      const bp = '/tmp/proj/.clubhouse/blueprints/file.txt';
      vi.mocked(fsp.realpath).mockResolvedValueOnce(bp);

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, bp);
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('returns false when file does not exist (realpath fails)', async () => {
      vi.mocked(fsp.realpath).mockRejectedValueOnce(new Error('ENOENT'));

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, '/tmp/proj/.clubhouse/blueprints/gone.json');
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('rejects symlink resolving outside blueprints dir', async () => {
      // Symlink inside blueprints dir that resolves to outside
      vi.mocked(fsp.realpath).mockResolvedValueOnce('/etc/shadow');

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, '/tmp/proj/.clubhouse/blueprints/symlink.json');
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    // ── Mission 74: cross-platform path handling ────────────────────────────
    // The suffix check must work whether realpath returns forward-slash
    // (POSIX) or backslash (Windows) paths. Tests below assert both styles
    // succeed for in-bounds paths and both styles still reject out-of-bounds.

    it('accepts a Windows-style backslash path inside blueprints dir', async () => {
      const bp = 'C:\\Users\\foo\\proj\\.clubhouse\\blueprints\\old.json';
      vi.mocked(fsp.realpath).mockResolvedValueOnce(bp);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, bp);
      expect(result).toBe(true);
      expect(fsp.unlink).toHaveBeenCalledWith(bp);
    });

    it('accepts a mixed-separator path inside blueprints dir', async () => {
      // Some Windows APIs return paths with mixed separators
      const bp = 'C:\\Users\\foo/proj/.clubhouse/blueprints\\old.json';
      vi.mocked(fsp.realpath).mockResolvedValueOnce(bp);
      vi.mocked(fsp.unlink).mockResolvedValue(undefined);

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, bp);
      expect(result).toBe(true);
    });

    it('rejects a Windows backslash path OUTSIDE blueprints dir', async () => {
      // Security: backslash paths must still be rejected when not in
      // .clubhouse\blueprints\
      vi.mocked(fsp.realpath).mockResolvedValueOnce('C:\\Users\\foo\\Documents\\important.json');

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, 'C:\\Users\\foo\\Documents\\important.json');
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });

    it('rejects a Windows backslash path with non-.json extension', async () => {
      const bp = 'C:\\Users\\foo\\proj\\.clubhouse\\blueprints\\file.txt';
      vi.mocked(fsp.realpath).mockResolvedValueOnce(bp);

      const handler = getHandler('blueprint:delete');
      const result = await handler({}, bp);
      expect(result).toBe(false);
      expect(fsp.unlink).not.toHaveBeenCalled();
    });
  });

  describe('BLUEPRINT.SAVE_TO_FILE', () => {
    it('writes the supplied content to the user-chosen path', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
        canceled: false,
        filePath: '/Users/me/Desktop/squad.json',
      } as any);
      vi.mocked(fsp.writeFile).mockResolvedValueOnce(undefined as never);

      const handler = getHandler('blueprint:save-to-file');
      const result = await handler({}, 'squad.json', '{"name":"Squad"}');

      expect(result).toEqual({ canceled: false, filePath: '/Users/me/Desktop/squad.json' });
      expect(fsp.writeFile).toHaveBeenCalledWith(
        '/Users/me/Desktop/squad.json',
        '{"name":"Squad"}',
        'utf-8',
      );
    });

    it('honors paths outside any registered project (no path-sandbox check)', async () => {
      // Critical: SAVE_TO_FILE must NOT call assertAllowedPath, or the user
      // wouldn't be able to save a blueprint to ~/Desktop.
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
        canceled: false,
        filePath: '/somewhere/outside/projects/x.json',
      } as any);
      vi.mocked(fsp.writeFile).mockResolvedValueOnce(undefined as never);

      const handler = getHandler('blueprint:save-to-file');
      await handler({}, 'x.json', '{}');

      expect(assertAllowedPath).not.toHaveBeenCalled();
      expect(fsp.writeFile).toHaveBeenCalled();
    });

    it('returns canceled when the user dismisses the dialog', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
        canceled: true,
        filePath: undefined,
      } as any);

      const handler = getHandler('blueprint:save-to-file');
      const result = await handler({}, 'x.json', '{}');

      expect(result).toEqual({ canceled: true });
      expect(fsp.writeFile).not.toHaveBeenCalled();
    });

    it('returns the error message when writeFile fails', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({
        canceled: false,
        filePath: '/readonly/x.json',
      } as any);
      vi.mocked(fsp.writeFile).mockRejectedValueOnce(new Error('EROFS: read-only'));

      const handler = getHandler('blueprint:save-to-file');
      const result = await handler({}, 'x.json', '{}') as any;

      expect(result.canceled).toBe(false);
      expect(result.filePath).toBe('/readonly/x.json');
      expect(result.error).toContain('EROFS');
    });
  });

  describe('BLUEPRINT.OPEN_AND_READ', () => {
    it('opens a dialog and returns parsed contents of the chosen file', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/Users/me/Downloads/team.json'],
      } as any);
      vi.mocked(fsp.readFile).mockResolvedValueOnce(JSON.stringify({
        schemaVersion: 1,
        name: 'Team',
        canvas: { views: [], wires: [] },
      }) as never);

      const handler = getHandler('blueprint:open-and-read');
      const result = await handler({}) as any;

      expect(result.canceled).toBe(false);
      expect(result.filePath).toBe('/Users/me/Downloads/team.json');
      expect(result.data).toEqual({
        schemaVersion: 1,
        name: 'Team',
        canvas: { views: [], wires: [] },
      });
    });

    it('honors paths outside any registered project (no path-sandbox check)', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/elsewhere/blueprint.json'],
      } as any);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('{}' as never);

      const handler = getHandler('blueprint:open-and-read');
      await handler({});

      expect(assertAllowedPath).not.toHaveBeenCalled();
      expect(fsp.readFile).toHaveBeenCalled();
    });

    it('returns canceled when the user dismisses the dialog', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: true,
        filePaths: [],
      } as any);

      const handler = getHandler('blueprint:open-and-read');
      const result = await handler({});

      expect(result).toEqual({ canceled: true });
      expect(fsp.readFile).not.toHaveBeenCalled();
    });

    it('returns canceled when the user picks no file (empty filePaths)', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: [],
      } as any);

      const handler = getHandler('blueprint:open-and-read');
      const result = await handler({});

      expect(result).toEqual({ canceled: true });
    });

    it('returns an error when the file is invalid JSON', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/tmp/broken.json'],
      } as any);
      vi.mocked(fsp.readFile).mockResolvedValueOnce('not valid json' as never);

      const handler = getHandler('blueprint:open-and-read');
      const result = await handler({}) as any;

      expect(result.canceled).toBe(false);
      expect(result.filePath).toBe('/tmp/broken.json');
      expect(result.error).toBeDefined();
      expect(result.data).toBeUndefined();
    });

    it('rejects oversized files (10 MB limit)', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
        canceled: false,
        filePaths: ['/tmp/huge.json'],
      } as any);
      vi.mocked(fsp.stat).mockResolvedValueOnce({ size: 11 * 1024 * 1024 } as any);

      const handler = getHandler('blueprint:open-and-read');
      const result = await handler({}) as any;

      expect(result.canceled).toBe(false);
      expect(result.error).toContain('too large');
      expect(fsp.readFile).not.toHaveBeenCalled();
    });
  });
});
