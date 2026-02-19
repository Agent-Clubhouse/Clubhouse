import { create } from 'zustand';
import type {
  PluginRegistryEntry,
  PluginModule,
  PluginStatus,
  PluginManifest,
  PluginSource,
  PluginPermission,
} from '../../shared/plugin-types';

export interface PermissionViolation {
  pluginId: string;
  pluginName: string;
  permission: PluginPermission;
  apiName: string;
  timestamp: number;
}

interface PluginState {
  plugins: Record<string, PluginRegistryEntry>;
  projectEnabled: Record<string, string[]>;   // projectId -> pluginIds
  appEnabled: string[];
  modules: Record<string, PluginModule>;
  safeModeActive: boolean;
  pluginSettings: Record<string, Record<string, unknown>>; // "projectId:pluginId" or "app:pluginId" -> settings
  externalPluginsEnabled: boolean;
  permissionViolations: PermissionViolation[];

  // Actions
  setExternalPluginsEnabled: (enabled: boolean) => void;
  registerPlugin: (manifest: PluginManifest, source: PluginSource, pluginPath: string, status?: PluginStatus, error?: string) => void;
  setPluginStatus: (pluginId: string, status: PluginStatus, error?: string) => void;
  setPluginModule: (pluginId: string, mod: PluginModule) => void;
  removePluginModule: (pluginId: string) => void;
  enableForProject: (projectId: string, pluginId: string) => void;
  disableForProject: (projectId: string, pluginId: string) => void;
  loadProjectPluginConfig: (projectId: string, enabledIds: string[]) => void;
  enableApp: (pluginId: string) => void;
  disableApp: (pluginId: string) => void;
  loadAppPluginConfig: (enabledIds: string[]) => void;
  setPluginSetting: (scope: string, pluginId: string, key: string, value: unknown) => void;
  loadPluginSettings: (settingsKey: string, settings: Record<string, unknown>) => void;
  setSafeModeActive: (active: boolean) => void;
  removePlugin: (pluginId: string) => void;
  recordPermissionViolation: (violation: PermissionViolation) => void;
  clearPermissionViolation: (pluginId: string) => void;
}

export const usePluginStore = create<PluginState>((set) => ({
  plugins: {},
  projectEnabled: {},
  appEnabled: [],
  modules: {},
  safeModeActive: false,
  pluginSettings: {},
  externalPluginsEnabled: false,
  permissionViolations: [],

  setExternalPluginsEnabled: (enabled) =>
    set({ externalPluginsEnabled: enabled }),

  registerPlugin: (manifest, source, pluginPath, status = 'registered', error) =>
    set((s) => ({
      plugins: {
        ...s.plugins,
        [manifest.id]: { manifest, status, error, source, pluginPath },
      },
    })),

  setPluginStatus: (pluginId, status, error) =>
    set((s) => {
      const entry = s.plugins[pluginId];
      if (!entry) return s;
      return {
        plugins: {
          ...s.plugins,
          [pluginId]: { ...entry, status, error: error ?? entry.error },
        },
      };
    }),

  setPluginModule: (pluginId, mod) =>
    set((s) => ({
      modules: { ...s.modules, [pluginId]: mod },
    })),

  removePluginModule: (pluginId) =>
    set((s) => {
      const { [pluginId]: _, ...rest } = s.modules;
      return { modules: rest };
    }),

  enableForProject: (projectId, pluginId) =>
    set((s) => {
      const current = s.projectEnabled[projectId] || [];
      if (current.includes(pluginId)) return s;
      return {
        projectEnabled: {
          ...s.projectEnabled,
          [projectId]: [...current, pluginId],
        },
      };
    }),

  disableForProject: (projectId, pluginId) =>
    set((s) => {
      const current = s.projectEnabled[projectId] || [];
      return {
        projectEnabled: {
          ...s.projectEnabled,
          [projectId]: current.filter((id) => id !== pluginId),
        },
      };
    }),

  loadProjectPluginConfig: (projectId, enabledIds) =>
    set((s) => ({
      projectEnabled: {
        ...s.projectEnabled,
        [projectId]: enabledIds,
      },
    })),

  enableApp: (pluginId) =>
    set((s) => {
      if (s.appEnabled.includes(pluginId)) return s;
      return { appEnabled: [...s.appEnabled, pluginId] };
    }),

  disableApp: (pluginId) =>
    set((s) => ({
      appEnabled: s.appEnabled.filter((id) => id !== pluginId),
    })),

  loadAppPluginConfig: (enabledIds) =>
    set({ appEnabled: enabledIds }),

  setPluginSetting: (scope, pluginId, key, value) =>
    set((s) => {
      const settingsKey = `${scope}:${pluginId}`;
      const current = s.pluginSettings[settingsKey] || {};
      return {
        pluginSettings: {
          ...s.pluginSettings,
          [settingsKey]: { ...current, [key]: value },
        },
      };
    }),

  loadPluginSettings: (settingsKey, settings) =>
    set((s) => ({
      pluginSettings: {
        ...s.pluginSettings,
        [settingsKey]: settings,
      },
    })),

  setSafeModeActive: (active) =>
    set({ safeModeActive: active }),

  removePlugin: (pluginId) =>
    set((s) => {
      const { [pluginId]: _, ...restPlugins } = s.plugins;
      const { [pluginId]: _mod, ...restModules } = s.modules;
      return {
        plugins: restPlugins,
        modules: restModules,
        appEnabled: s.appEnabled.filter((id) => id !== pluginId),
        projectEnabled: Object.fromEntries(
          Object.entries(s.projectEnabled).map(([pid, ids]) => [pid, ids.filter((id) => id !== pluginId)]),
        ),
      };
    }),

  recordPermissionViolation: (violation) =>
    set((s) => ({
      permissionViolations: [...s.permissionViolations, violation],
    })),

  clearPermissionViolation: (pluginId) =>
    set((s) => ({
      permissionViolations: s.permissionViolations.filter((v) => v.pluginId !== pluginId),
    })),
}));
