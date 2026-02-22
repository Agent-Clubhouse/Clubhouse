import { create } from 'zustand';
import type { SourceControlProvider } from '../../shared/types';

interface ClubhouseModeState {
  enabled: boolean;
  projectOverrides: Record<string, boolean>;
  sourceControlProvider: SourceControlProvider;
  loadSettings: () => Promise<void>;
  setEnabled: (enabled: boolean, projectPath?: string) => Promise<void>;
  isEnabledForProject: (projectPath?: string) => boolean;
  setProjectOverride: (projectPath: string, enabled: boolean) => Promise<void>;
  clearProjectOverride: (projectPath: string) => Promise<void>;
  setSourceControlProvider: (provider: SourceControlProvider) => Promise<void>;
}

export const useClubhouseModeStore = create<ClubhouseModeState>((set, get) => ({
  enabled: false,
  projectOverrides: {},
  sourceControlProvider: 'github',

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getClubhouseModeSettings();
      set({
        enabled: settings?.enabled ?? false,
        projectOverrides: settings?.projectOverrides ?? {},
        sourceControlProvider: settings?.sourceControlProvider ?? 'github',
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
        { enabled, projectOverrides: get().projectOverrides, sourceControlProvider: get().sourceControlProvider },
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
        { enabled: get().enabled, projectOverrides: newOverrides, sourceControlProvider: get().sourceControlProvider },
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
        { enabled: get().enabled, projectOverrides: rest, sourceControlProvider: get().sourceControlProvider },
        projectPath,
      );
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  setSourceControlProvider: async (provider) => {
    const prev = get().sourceControlProvider;
    set({ sourceControlProvider: provider });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled: get().enabled, projectOverrides: get().projectOverrides, sourceControlProvider: provider },
      );
    } catch {
      set({ sourceControlProvider: prev });
    }
  },
}));
