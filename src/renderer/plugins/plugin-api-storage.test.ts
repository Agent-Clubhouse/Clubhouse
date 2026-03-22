import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createScopedStorage, createStorageAPI } from './plugin-api-storage';
import type { PluginContext } from '../../shared/plugin-types';

const mockStorageRead = vi.fn();
const mockStorageWrite = vi.fn();
const mockStorageDelete = vi.fn();
const mockStorageList = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).clubhouse = {
    plugin: {
      storageRead: mockStorageRead,
      storageWrite: mockStorageWrite,
      storageDelete: mockStorageDelete,
      storageList: mockStorageList,
    },
  };
});

describe('createScopedStorage', () => {
  it('read delegates to storageRead with correct scope', async () => {
    mockStorageRead.mockResolvedValue({ key: 'value' });
    const storage = createScopedStorage('my-plugin', 'project', '/project/path');

    const result = await storage.read('settings');
    expect(mockStorageRead).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      scope: 'project',
      key: 'settings',
      projectPath: '/project/path',
    });
    expect(result).toEqual({ key: 'value' });
  });

  it('write delegates to storageWrite with correct scope', async () => {
    mockStorageWrite.mockResolvedValue(undefined);
    const storage = createScopedStorage('my-plugin', 'global');

    await storage.write('config', { enabled: true });
    expect(mockStorageWrite).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      scope: 'global',
      key: 'config',
      value: { enabled: true },
      projectPath: undefined,
    });
  });

  it('delete delegates to storageDelete with correct scope', async () => {
    mockStorageDelete.mockResolvedValue(undefined);
    const storage = createScopedStorage('my-plugin', 'project-local', '/path');

    await storage.delete('cache');
    expect(mockStorageDelete).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      scope: 'project-local',
      key: 'cache',
      projectPath: '/path',
    });
  });

  it('list delegates to storageList with correct scope', async () => {
    mockStorageList.mockResolvedValue(['key1', 'key2']);
    const storage = createScopedStorage('my-plugin', 'global');

    const result = await storage.list();
    expect(mockStorageList).toHaveBeenCalledWith({
      pluginId: 'my-plugin',
      scope: 'global',
      projectPath: undefined,
    });
    expect(result).toEqual(['key1', 'key2']);
  });
});

describe('createStorageAPI', () => {
  it('creates project, projectLocal, and global scoped storage', () => {
    const ctx: PluginContext = {
      pluginId: 'test-plugin',
      projectPath: '/test/project',
      projectId: 'proj_1',
      scope: 'project',
    };

    const api = createStorageAPI(ctx);
    expect(api.project).toBeDefined();
    expect(api.projectLocal).toBeDefined();
    expect(api.global).toBeDefined();
  });

  it('project storage uses project scope', async () => {
    mockStorageRead.mockResolvedValue(null);
    const ctx: PluginContext = {
      pluginId: 'test-plugin',
      projectPath: '/test/project',
      projectId: 'proj_1',
      scope: 'project',
    };

    const api = createStorageAPI(ctx);
    await api.project.read('key');
    expect(mockStorageRead).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', projectPath: '/test/project' }),
    );
  });

  it('global storage uses global scope without projectPath', async () => {
    mockStorageRead.mockResolvedValue(null);
    const ctx: PluginContext = {
      pluginId: 'test-plugin',
      projectPath: '/test/project',
      projectId: 'proj_1',
      scope: 'project',
    };

    const api = createStorageAPI(ctx);
    await api.global.read('key');
    expect(mockStorageRead).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'global', projectPath: undefined }),
    );
  });
});
