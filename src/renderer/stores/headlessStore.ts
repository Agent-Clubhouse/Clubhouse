import { create } from 'zustand';
import { optimisticUpdate } from './optimistic-update';
import type { SpawnMode } from '../../shared/types';

export type { SpawnMode };

interface HeadlessState {
  defaultMode: SpawnMode;
  projectOverrides: Record<string, SpawnMode>;
  loadSettings: () => Promise<void>;
  setDefaultMode: (mode: SpawnMode) => Promise<void>;
  getProjectMode: (projectPath?: string) => SpawnMode;
  setProjectMode: (projectPath: string, mode: SpawnMode) => Promise<void>;
  clearProjectMode: (projectPath: string) => Promise<void>;
}

export const useHeadlessStore = create<HeadlessState>((set, get) => ({
  defaultMode: 'headless',
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getHeadlessSettings();
      const defaultMode: SpawnMode = settings?.defaultMode
        ?? (settings?.enabled !== false ? 'headless' : 'interactive');
      set({
        defaultMode,
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
      () => window.clubhouse.app.saveHeadlessSettings({
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
      () => window.clubhouse.app.saveHeadlessSettings({
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
      () => window.clubhouse.app.saveHeadlessSettings({
        defaultMode,
        projectOverrides: rest,
      }),
    );
  },
}));
