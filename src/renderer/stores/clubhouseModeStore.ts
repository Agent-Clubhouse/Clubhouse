import { create } from 'zustand';

interface ClubhouseModeState {
  enabled: boolean;
  projectOverrides: Record<string, boolean>;
  loadSettings: () => Promise<void>;
  setEnabled: (enabled: boolean, projectPath?: string) => Promise<void>;
  isEnabledForProject: (projectPath?: string) => boolean;
  setProjectOverride: (projectPath: string, enabled: boolean) => Promise<void>;
  clearProjectOverride: (projectPath: string) => Promise<void>;
}

export const useClubhouseModeStore = create<ClubhouseModeState>((set, get) => ({
  enabled: false,
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getClubhouseModeSettings();
      set({
        enabled: settings?.enabled ?? false,
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep default
    }
  },

  setEnabled: async (enabled, projectPath?) => {
    const prev = get().enabled;
    set({ enabled });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides: get().projectOverrides },
        projectPath,
      );
    } catch {
      set({ enabled: prev });
    }
  },

  isEnabledForProject: (projectPath?) => {
    const { enabled, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath] !== undefined) {
      return projectOverrides[projectPath];
    }
    return enabled;
  },

  setProjectOverride: async (projectPath, enabled) => {
    const prevOverrides = get().projectOverrides;
    const newOverrides = { ...prevOverrides, [projectPath]: enabled };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled: get().enabled, projectOverrides: newOverrides },
        projectPath,
      );
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectOverride: async (projectPath) => {
    const prevOverrides = get().projectOverrides;
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled: get().enabled, projectOverrides: rest },
        projectPath,
      );
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
