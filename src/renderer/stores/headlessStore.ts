import { create } from 'zustand';

export type SpawnMode = 'headless' | 'interactive';

interface HeadlessState {
  enabled: boolean;
  projectOverrides: Record<string, SpawnMode>;
  loadSettings: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
  getProjectMode: (projectPath?: string) => SpawnMode;
  setProjectMode: (projectPath: string, mode: SpawnMode) => Promise<void>;
  clearProjectMode: (projectPath: string) => Promise<void>;
}

export const useHeadlessStore = create<HeadlessState>((set, get) => ({
  enabled: false,
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getHeadlessSettings();
      set({
        enabled: settings?.enabled ?? false,
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep default
    }
  },

  setEnabled: async (enabled) => {
    const prev = get().enabled;
    set({ enabled });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        enabled,
        projectOverrides: get().projectOverrides,
      });
    } catch {
      set({ enabled: prev });
    }
  },

  getProjectMode: (projectPath?) => {
    const { enabled, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath]) {
      return projectOverrides[projectPath];
    }
    return enabled ? 'headless' : 'interactive';
  },

  setProjectMode: async (projectPath, mode) => {
    const prevOverrides = get().projectOverrides;
    const newOverrides = { ...prevOverrides, [projectPath]: mode };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        enabled: get().enabled,
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
        enabled: get().enabled,
        projectOverrides: rest,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
