import { create } from 'zustand';
import type { SourceControlProvider } from '../../shared/types';
import { optimisticUpdate } from './optimistic-update';

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
    const { projectOverrides, sourceControlProvider } = get();
    await optimisticUpdate(set, get,
      { enabled },
      () => window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides, sourceControlProvider },
        projectPath,
      ),
    );
  },

  isEnabledForProject: (projectPath?) => {
    const { enabled, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath] !== undefined) {
      return projectOverrides[projectPath];
    }
    return enabled;
  },

  setProjectOverride: async (projectPath, enabled) => {
    const { enabled: currentEnabled, sourceControlProvider } = get();
    const newOverrides = { ...get().projectOverrides, [projectPath]: enabled };
    await optimisticUpdate(set, get,
      { projectOverrides: newOverrides },
      () => window.clubhouse.app.saveClubhouseModeSettings(
        { enabled: currentEnabled, projectOverrides: newOverrides, sourceControlProvider },
        projectPath,
      ),
    );
  },

  clearProjectOverride: async (projectPath) => {
    const { enabled, projectOverrides, sourceControlProvider } = get();
    const { [projectPath]: _, ...rest } = projectOverrides;
    await optimisticUpdate(set, get,
      { projectOverrides: rest },
      () => window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides: rest, sourceControlProvider },
      ),
    );
  },

  setSourceControlProvider: async (provider) => {
    const { enabled, projectOverrides } = get();
    await optimisticUpdate(set, get,
      { sourceControlProvider: provider },
      () => window.clubhouse.app.saveClubhouseModeSettings(
        { enabled, projectOverrides, sourceControlProvider: provider },
      ),
    );
  },
}));
