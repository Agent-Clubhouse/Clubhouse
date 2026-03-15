import type { PluginContext, StorageAPI, ScopedStorage } from '../../shared/plugin-types';

export function createScopedStorage(pluginId: string, storageScope: 'project' | 'project-local' | 'global', projectPath?: string): ScopedStorage {
  return {
    async read(key: string): Promise<unknown> {
      return window.clubhouse.plugin.storageRead({ pluginId, scope: storageScope, key, projectPath });
    },
    async write(key: string, value: unknown): Promise<void> {
      await window.clubhouse.plugin.storageWrite({ pluginId, scope: storageScope, key, value, projectPath });
    },
    async delete(key: string): Promise<void> {
      await window.clubhouse.plugin.storageDelete({ pluginId, scope: storageScope, key, projectPath });
    },
    async list(): Promise<string[]> {
      return window.clubhouse.plugin.storageList({ pluginId, scope: storageScope, projectPath });
    },
  };
}

export function createStorageAPI(ctx: PluginContext): StorageAPI {
  return {
    project: createScopedStorage(ctx.pluginId, 'project', ctx.projectPath),
    projectLocal: createScopedStorage(ctx.pluginId, 'project-local', ctx.projectPath),
    global: createScopedStorage(ctx.pluginId, 'global'),
  };
}
