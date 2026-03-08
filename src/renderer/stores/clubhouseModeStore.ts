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
    const { enabled: prev, projectOverrides, sourceControlProvider } = get();
    set({ enabled });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides, sourceControlProvider },
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
    const { enabled: currentEnabled, projectOverrides: prevOverrides, sourceControlProvider } = get();
    const newOverrides = { ...prevOverrides, [projectPath]: enabled };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled: currentEnabled, projectOverrides: newOverrides, sourceControlProvider },
        projectPath,
      );
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectOverride: async (projectPath) => {
    const { enabled, projectOverrides: prevOverrides, sourceControlProvider } = get();
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides: rest, sourceControlProvider },
        projectPath,
      );
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  setSourceControlProvider: async (provider) => {
    const { sourceControlProvider: prev, enabled, projectOverrides } = get();
    set({ sourceControlProvider: provider });
    try {
      await window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides, sourceControlProvider: provider },
      );
    } catch {
      set({ sourceControlProvider: prev });
    }
  },
}));
