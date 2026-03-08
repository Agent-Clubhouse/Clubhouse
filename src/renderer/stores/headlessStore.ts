import { create } from 'zustand';

export type SpawnMode = 'headless' | 'interactive' | 'structured';

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
    const prev = get().defaultMode;
    set({ defaultMode: mode });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: mode,
        projectOverrides: get().projectOverrides,
      });
    } catch {
      set({ defaultMode: prev });
    }
  },

  getProjectMode: (projectPath?) => {
    const { defaultMode, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath]) {
      return projectOverrides[projectPath];
    }
    return defaultMode;
  },

  setProjectMode: async (projectPath, mode) => {
    const prevOverrides = get().projectOverrides;
    const newOverrides = { ...prevOverrides, [projectPath]: mode };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: get().defaultMode,
        projectOverrides: newOverrides,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectMode: async (projectPath) => {
    const prevOverrides = get().projectOverrides;
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: get().defaultMode,
        projectOverrides: rest,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
