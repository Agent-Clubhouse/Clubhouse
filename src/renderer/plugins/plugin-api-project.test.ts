import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProjectAPI } from './plugin-api-project';
import type { PluginContext } from '../../shared/plugin-types';

const mockRead = vi.fn();
const mockWrite = vi.fn();
const mockDelete = vi.fn();
const mockReadTree = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).clubhouse = {
    file: {
      read: mockRead,
      write: mockWrite,
      delete: mockDelete,
      readTree: mockReadTree,
    },
  };
});

describe('createProjectAPI', () => {
  const ctx: PluginContext = {
    pluginId: 'test-plugin',
    projectPath: '/project/root',
    projectId: 'proj_1',
    scope: 'project',
  };

  it('throws if projectPath is missing', () => {
    const badCtx: PluginContext = { pluginId: 'p', scope: 'app' };
    expect(() => createProjectAPI(badCtx)).toThrow('requires projectPath');
  });

  it('throws if projectId is missing', () => {
    const badCtx: PluginContext = { pluginId: 'p', projectPath: '/path', scope: 'project' };
    expect(() => createProjectAPI(badCtx)).toThrow('requires projectPath');
  });

  it('exposes projectPath and projectId', () => {
    const api = createProjectAPI(ctx);
    expect(api.projectPath).toBe('/project/root');
    expect(api.projectId).toBe('proj_1');
  });

  describe('readFile', () => {
    it('constructs full path from projectPath + relativePath', async () => {
      mockRead.mockResolvedValue('file content');
      const api = createProjectAPI(ctx);

      const result = await api.readFile('src/index.ts');
      expect(mockRead).toHaveBeenCalledWith('/project/root/src/index.ts');
      expect(result).toBe('file content');
    });

    it('propagates read errors', async () => {
      mockRead.mockRejectedValue(new Error('ENOENT'));
      const api = createProjectAPI(ctx);
      await expect(api.readFile('missing.ts')).rejects.toThrow('ENOENT');
    });
  });

  describe('writeFile', () => {
    it('constructs full path and delegates to file.write', async () => {
      mockWrite.mockResolvedValue(undefined);
      const api = createProjectAPI(ctx);

      await api.writeFile('output.txt', 'hello');
      expect(mockWrite).toHaveBeenCalledWith('/project/root/output.txt', 'hello');
    });
  });

  describe('deleteFile', () => {
    it('constructs full path and delegates to file.delete', async () => {
      mockDelete.mockResolvedValue(undefined);
      const api = createProjectAPI(ctx);

      await api.deleteFile('temp.txt');
      expect(mockDelete).toHaveBeenCalledWith('/project/root/temp.txt');
    });
  });

  describe('fileExists', () => {
    it('returns true when file can be read', async () => {
      mockRead.mockResolvedValue('content');
      const api = createProjectAPI(ctx);

      const result = await api.fileExists('exists.ts');
      expect(result).toBe(true);
    });

    it('returns false when read throws', async () => {
      mockRead.mockRejectedValue(new Error('ENOENT'));
      const api = createProjectAPI(ctx);

      const result = await api.fileExists('missing.ts');
      expect(result).toBe(false);
    });
  });

  describe('listDirectory', () => {
    it('maps readTree results to DirectoryEntry format', async () => {
      mockReadTree.mockResolvedValue([
        { name: 'src', path: '/project/root/src', isDirectory: true },
        { name: 'index.ts', path: '/project/root/index.ts', isDirectory: false },
      ]);
      const api = createProjectAPI(ctx);

      const entries = await api.listDirectory('.');
      expect(mockReadTree).toHaveBeenCalledWith('/project/root/.');
      expect(entries).toEqual([
        { name: 'src', path: '/project/root/src', isDirectory: true },
        { name: 'index.ts', path: '/project/root/index.ts', isDirectory: false },
      ]);
    });

    it('defaults to current directory when no path provided', async () => {
      mockReadTree.mockResolvedValue([]);
      const api = createProjectAPI(ctx);

      await api.listDirectory();
      expect(mockReadTree).toHaveBeenCalledWith('/project/root/.');
    });
  });
});
