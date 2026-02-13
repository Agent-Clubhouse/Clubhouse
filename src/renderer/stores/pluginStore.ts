import { create } from 'zustand';
import { getPluginIds } from '../plugins/registry';

interface PluginStoreState {
  /** projectId → array of enabled plugin IDs */
  enabledPlugins: Record<string, string[]>;

  /** Load plugin config for a project from disk, defaulting all plugins to enabled. */
  loadPluginConfig: (projectId: string, projectPath: string) => Promise<void>;

  /** Enable or disable a specific plugin for a project, persisting to disk. */
  setPluginEnabled: (projectId: string, projectPath: string, pluginId: string, enabled: boolean) => Promise<void>;

  /** Check if a plugin is enabled for the given project. Returns true if no config loaded (default-on). */
  isPluginEnabled: (projectId: string, pluginId: string) => boolean;

  /** Get list of enabled plugin IDs for a project. */
  getEnabledPluginIds: (projectId: string) => string[];
}

function configPath(projectPath: string): string {
  return `${projectPath}/.clubhouse/plugins.json`;
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  enabledPlugins: {},

  loadPluginConfig: async (projectId, projectPath) => {
    const allIds = getPluginIds();
    try {
      const content = await window.clubhouse.file.read(configPath(projectPath));
      const data = JSON.parse(content) as { enabled?: string[] };
      if (Array.isArray(data.enabled)) {
        set((s) => ({
          enabledPlugins: { ...s.enabledPlugins, [projectId]: data.enabled! },
        }));
        return;
      }
    } catch {
      // File doesn't exist or is invalid — default all plugins to enabled
    }
    set((s) => ({
      enabledPlugins: { ...s.enabledPlugins, [projectId]: [...allIds] },
    }));
  },

  setPluginEnabled: async (projectId, projectPath, pluginId, enabled) => {
    const current = get().enabledPlugins[projectId] ?? getPluginIds();
    const updated = enabled
      ? current.includes(pluginId) ? current : [...current, pluginId]
      : current.filter((id) => id !== pluginId);

    set((s) => ({
      enabledPlugins: { ...s.enabledPlugins, [projectId]: updated },
    }));

    try {
      await window.clubhouse.file.write(
        configPath(projectPath),
        JSON.stringify({ enabled: updated }, null, 2),
      );
    } catch {
      // Persist failure is non-fatal
    }
  },

  isPluginEnabled: (projectId, pluginId) => {
    const list = get().enabledPlugins[projectId];
    if (!list) return true; // No config loaded yet — default enabled
    return list.includes(pluginId);
  },

  getEnabledPluginIds: (projectId) => {
    return get().enabledPlugins[projectId] ?? getPluginIds();
  },
}));
