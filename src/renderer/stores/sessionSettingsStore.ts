import { create } from 'zustand';

interface SessionSettingsState {
  promptForName: boolean;
  projectOverrides: Record<string, boolean>;
  loadSettings: () => Promise<void>;
  setPromptForName: (enabled: boolean) => Promise<void>;
  shouldPrompt: (projectPath?: string) => boolean;
  setProjectOverride: (projectPath: string, value: boolean) => Promise<void>;
  clearProjectOverride: (projectPath: string) => Promise<void>;
}

export const useSessionSettingsStore = create<SessionSettingsState>((set, get) => ({
  promptForName: false,
  projectOverrides: {},

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getSessionSettings();
      set({
        promptForName: settings?.promptForName ?? false,
        projectOverrides: settings?.projectOverrides ?? {},
      });
    } catch {
      // Keep defaults
    }
  },

  setPromptForName: async (enabled) => {
    const prev = get().promptForName;
    set({ promptForName: enabled });
    try {
      await window.clubhouse.app.saveSessionSettings({
        promptForName: enabled,
        projectOverrides: get().projectOverrides,
      });
    } catch {
      set({ promptForName: prev });
    }
  },

  shouldPrompt: (projectPath?) => {
    const { promptForName, projectOverrides } = get();
    if (projectPath && projectOverrides[projectPath] !== undefined) {
      return projectOverrides[projectPath];
    }
    return promptForName;
  },

  setProjectOverride: async (projectPath, value) => {
    const prevOverrides = get().projectOverrides;
    const newOverrides = { ...prevOverrides, [projectPath]: value };
    set({ projectOverrides: newOverrides });
    try {
      await window.clubhouse.app.saveSessionSettings({
        promptForName: get().promptForName,
        projectOverrides: newOverrides,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },

  clearProjectOverride: async (projectPath) => {
    const prevOverrides = get().projectOverrides;
    const { [projectPath]: _, ...rest } = prevOverrides;
    set({ projectOverrides: rest });
    try {
      await window.clubhouse.app.saveSessionSettings({
        promptForName: get().promptForName,
        projectOverrides: rest,
      });
    } catch {
      set({ projectOverrides: prevOverrides });
    }
  },
}));
