import { create } from 'zustand';

export type SpawnMode = 'headless' | 'interactive' | 'structured';

interface HeadlessState {
  /** @deprecated Read via `defaultMode` instead */
  enabled: boolean;
  defaultMode: SpawnMode;
  projectOverrides: Record<string, SpawnMode>;
  loadSettings: () => Promise<void>;
  setDefaultMode: (mode: SpawnMode) => Promise<void>;
  /** @deprecated Use `setDefaultMode` instead */
  setEnabled: (enabled: boolean) => Promise<void>;
  getProjectMode: (projectPath?: string) => SpawnMode;
  setProjectMode: (projectPath: string, mode: SpawnMode) => Promise<void>;
  clearProjectMode: (projectPath: string) => Promise<void>;
}

export const useHeadlessStore = create<HeadlessState>((set, get) => ({
  enabled: true,
  defaultMode: 'headless',
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getHeadlessSettings();
      const defaultMode: SpawnMode = settings?.defaultMode
        ?? (settings?.enabled !== false ? 'headless' : 'interactive');
      set({
        enabled: defaultMode === 'headless',
        defaultMode,
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep default
    }
  },

  setDefaultMode: async (mode) => {
    const { defaultMode: prev, projectOverrides } = get();
    set({ defaultMode: mode, enabled: mode === 'headless' });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode: mode,
        projectOverrides,
      });
    } catch {
      set({ defaultMode: prev, enabled: prev === 'headless' });
    }
  },

  setEnabled: async (enabled) => {
    const mode = enabled ? 'headless' : 'interactive';
    await get().setDefaultMode(mode);
  },

  getProjectMode: (projectPath?) => {
    const { defaultMode, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath]) {
      return projectOverrides[projectPath];
    }
    return defaultMode;
  },

  setProjectMode: async (projectPath, mode) => {
    const { defaultMode, projectOverrides: prevOverrides } = get();
    const newOverrides = { ...prevOverrides, [projectPath]: mode };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode,
        projectOverrides: newOverrides,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectMode: async (projectPath) => {
    const { defaultMode, projectOverrides: prevOverrides } = get();
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveHeadlessSettings({
        defaultMode,
        projectOverrides: rest,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
