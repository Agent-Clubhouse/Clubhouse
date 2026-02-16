import { create } from 'zustand';
import { getPluginIds } from '../plugins/registry';

const DEFAULT_PLUGINS: string[] = [];

interface PluginConfig {
  enabled: string[];
  hiddenCoreTabs: string[];
}

interface PluginStoreState {
  /** projectId → array of enabled plugin IDs */
  enabledPlugins: Record<string, string[]>;

  /** projectId → array of hidden core tab IDs */
  hiddenCoreTabs: Record<string, string[]>;

  /** Load plugin config for a project from disk, defaulting to core plugins only. */
  loadPluginConfig: (projectId: string, projectPath: string) => Promise<void>;

  /** Enable or disable a specific plugin for a project, persisting to disk. */
  setPluginEnabled: (projectId: string, projectPath: string, pluginId: string, enabled: boolean) => Promise<void>;

  /** Check if a plugin is enabled for the given project. Returns true if no config loaded (default-on). */
  isPluginEnabled: (projectId: string, pluginId: string) => boolean;

  /** Get list of enabled plugin IDs for a project. */
  getEnabledPluginIds: (projectId: string) => string[];

  /** Check if a core tab is hidden for the given project. */
  isCoreTabHidden: (projectId: string, tabId: string) => boolean;

  /** Show or hide a core tab for a project, persisting to disk. */
  setCoreTabHidden: (projectId: string, projectPath: string, tabId: string, hidden: boolean) => Promise<void>;
}

function configPath(projectPath: string): string {
  return `${projectPath}/.clubhouse/plugins.json`;
}

function buildConfigJson(state: PluginStoreState, projectId: string): string {
  const enabled = state.enabledPlugins[projectId] ?? [...DEFAULT_PLUGINS];
  const hiddenCoreTabs = state.hiddenCoreTabs[projectId] ?? [];
  const data: Record<string, unknown> = { enabled };
  if (hiddenCoreTabs.length > 0) {
    data.hiddenCoreTabs = hiddenCoreTabs;
  }
  return JSON.stringify(data, null, 2);
}

export const usePluginStore = create<PluginStoreState>((set, get) => ({
  enabledPlugins: {},
  hiddenCoreTabs: {},

  loadPluginConfig: async (projectId, projectPath) => {
    try {
      const content = await window.clubhouse.file.read(configPath(projectPath));
      const data = JSON.parse(content) as Partial<PluginConfig>;
      if (Array.isArray(data.enabled)) {
        set((s) => ({
          enabledPlugins: { ...s.enabledPlugins, [projectId]: data.enabled! },
          hiddenCoreTabs: {
            ...s.hiddenCoreTabs,
            [projectId]: Array.isArray(data.hiddenCoreTabs) ? data.hiddenCoreTabs : [],
          },
        }));
        return;
      }
    } catch {
      // File doesn't exist or is invalid — default to core plugins
    }
    set((s) => ({
      enabledPlugins: { ...s.enabledPlugins, [projectId]: [...DEFAULT_PLUGINS] },
      hiddenCoreTabs: { ...s.hiddenCoreTabs, [projectId]: [] },
    }));
  },

  setPluginEnabled: async (projectId, projectPath, pluginId, enabled) => {
    const current = get().enabledPlugins[projectId] ?? [...DEFAULT_PLUGINS];
    const updated = enabled
      ? current.includes(pluginId) ? current : [...current, pluginId]
      : current.filter((id) => id !== pluginId);

    set((s) => ({
      enabledPlugins: { ...s.enabledPlugins, [projectId]: updated },
    }));

    try {
      await window.clubhouse.file.write(
        configPath(projectPath),
        buildConfigJson(get(), projectId),
      );
    } catch {
      // Persist failure is non-fatal
    }
  },

  isPluginEnabled: (projectId, pluginId) => {
    const list = get().enabledPlugins[projectId];
    if (!list) return DEFAULT_PLUGINS.includes(pluginId);
    return list.includes(pluginId);
  },

  getEnabledPluginIds: (projectId) => {
    return get().enabledPlugins[projectId] ?? [...DEFAULT_PLUGINS];
  },

  isCoreTabHidden: (projectId, tabId) => {
    const hidden = get().hiddenCoreTabs[projectId];
    if (!hidden) return false;
    return hidden.includes(tabId);
  },

  setCoreTabHidden: async (projectId, projectPath, tabId, hidden) => {
    const current = get().hiddenCoreTabs[projectId] ?? [];
    const updated = hidden
      ? current.includes(tabId) ? current : [...current, tabId]
      : current.filter((id) => id !== tabId);

    set((s) => ({
      hiddenCoreTabs: { ...s.hiddenCoreTabs, [projectId]: updated },
    }));

    try {
      await window.clubhouse.file.write(
        configPath(projectPath),
        buildConfigJson(get(), projectId),
      );
    } catch {
      // Persist failure is non-fatal
    }
  },
}));
