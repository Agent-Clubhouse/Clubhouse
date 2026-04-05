import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createProjectAPI, createProjectsAPI } from './plugin-api-project';
import type { PluginContext } from '../../shared/plugin-types';
import { useProjectStore } from '../stores/projectStore';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';

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

describe('createProjectsAPI', () => {
  beforeEach(() => {
    useProjectStore.setState({ projects: [] });
    useRemoteProjectStore.setState({
      satelliteProjects: {},
    });
  });

  it('returns local projects', () => {
    useProjectStore.setState({
      projects: [
        { id: 'proj-1', name: 'LocalProject', displayName: 'Local Project', path: '/local/path' },
      ] as any,
    });

    const api = createProjectsAPI();
    const list = api.list();
    expect(list).toEqual([
      { id: 'proj-1', name: 'Local Project', path: '/local/path' },
    ]);
  });

  it('includes remote satellite projects', () => {
    useProjectStore.setState({ projects: [] });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [
          {
            id: 'remote||sat-1||proj-r1',
            name: 'RemoteProject',
            displayName: 'Remote Project',
            path: '__remote__',
            remote: true,
            satelliteId: 'sat-1',
            satelliteName: 'MySatellite',
          },
        ] as any,
      },
    });

    const api = createProjectsAPI();
    const list = api.list();
    expect(list).toEqual([
      { id: 'remote||sat-1||proj-r1', name: 'Remote Project', path: '__remote__' },
    ]);
  });

  it('merges local and remote projects', () => {
    useProjectStore.setState({
      projects: [
        { id: 'proj-1', name: 'LocalA', displayName: '', path: '/local/a' },
      ] as any,
    });
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [
          {
            id: 'remote||sat-1||proj-r1',
            name: 'RemoteB',
            displayName: 'Remote B',
            path: '__remote__',
            remote: true,
            satelliteId: 'sat-1',
            satelliteName: 'Sat1',
          },
        ] as any,
      },
    });

    const api = createProjectsAPI();
    const list = api.list();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('proj-1');
    expect(list[0].name).toBe('LocalA');
    expect(list[1].id).toBe('remote||sat-1||proj-r1');
    expect(list[1].name).toBe('Remote B');
  });

  it('returns empty array when no projects exist', () => {
    const api = createProjectsAPI();
    const list = api.list();
    expect(list).toEqual([]);
  });

  it('includes remote projects from multiple satellites', () => {
    useRemoteProjectStore.setState({
      satelliteProjects: {
        'sat-1': [
          { id: 'remote||sat-1||p1', name: 'P1', displayName: '', path: '__remote__', remote: true, satelliteId: 'sat-1', satelliteName: 'S1' },
        ] as any,
        'sat-2': [
          { id: 'remote||sat-2||p2', name: 'P2', displayName: '', path: '__remote__', remote: true, satelliteId: 'sat-2', satelliteName: 'S2' },
        ] as any,
      },
    });

    const api = createProjectsAPI();
    const list = api.list();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.id)).toContain('remote||sat-1||p1');
    expect(list.map((p) => p.id)).toContain('remote||sat-2||p2');
  });
});
