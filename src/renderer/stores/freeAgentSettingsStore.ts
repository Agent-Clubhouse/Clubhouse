import { create } from 'zustand';
import { optimisticUpdate } from './optimistic-update';
import type { FreeAgentPermissionMode } from '../../shared/types';

export type { FreeAgentPermissionMode };

interface FreeAgentSettingsState {
  defaultMode: FreeAgentPermissionMode;
  projectOverrides: Record<string, FreeAgentPermissionMode>;
  loadSettings: () => Promise<void>;
  setDefaultMode: (mode: FreeAgentPermissionMode) => Promise<void>;
  getProjectMode: (projectPath?: string) => FreeAgentPermissionMode;
  setProjectMode: (projectPath: string, mode: FreeAgentPermissionMode) => Promise<void>;
  clearProjectMode: (projectPath: string) => Promise<void>;
}

export const useFreeAgentSettingsStore = create<FreeAgentSettingsState>((set, get) => ({
  defaultMode: 'auto',
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getFreeAgentSettings();
      set({
        defaultMode: settings?.defaultMode ?? 'auto',
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep default
    }
  },

  setDefaultMode: async (mode) => {
    const { projectOverrides } = get();
    await optimisticUpdate(set, get,
      { defaultMode: mode },
      () => window.clubhouse.app.saveFreeAgentSettings({
        defaultMode: mode,
        projectOverrides,
      }),
    );
  },

  getProjectMode: (projectPath?) => {
    const { defaultMode, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath]) {
      return projectOverrides[projectPath];
    }
    return defaultMode;
  },

  setProjectMode: async (projectPath, mode) => {
    const { defaultMode } = get();
    const newOverrides = { ...get().projectOverrides, [projectPath]: mode };
    await optimisticUpdate(set, get,
      { projectOverrides: newOverrides },
      () => window.clubhouse.app.saveFreeAgentSettings({
        defaultMode,
        projectOverrides: newOverrides,
      }),
    );
  },

  clearProjectMode: async (projectPath) => {
    const { defaultMode, projectOverrides } = get();
    const { [projectPath]: _, ...rest } = projectOverrides;
    await optimisticUpdate(set, get,
      { projectOverrides: rest },
      () => window.clubhouse.app.saveFreeAgentSettings({
        defaultMode,
        projectOverrides: rest,
      }),
    );
  },
}));
