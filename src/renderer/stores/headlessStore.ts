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
    const { defaultMode: prevDefaultMode, projectOverrides: currentOverrides } = get();
    set({ defaultMode: mode });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: mode,
        projectOverrides: currentOverrides,
      });
    } catch {
      set({ defaultMode: prevDefaultMode });
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
    const { projectOverrides: prevOverrides, defaultMode: currentDefault } = get();
    const newOverrides = { ...prevOverrides, [projectPath]: mode };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: currentDefault,
        projectOverrides: newOverrides,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectMode: async (projectPath) => {
    const { projectOverrides: prevOverrides, defaultMode: currentDefault } = get();
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: currentDefault,
        projectOverrides: rest,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
