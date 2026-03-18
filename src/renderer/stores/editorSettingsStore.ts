import { create } from 'zustand';
import type { EditorSettings } from '../../shared/types';
import { EDITOR_SETTINGS } from '../../shared/settings-definitions';

interface EditorSettingsState extends EditorSettings {
  loaded: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (updates: Partial<EditorSettings>) => Promise<void>;
}

export const useEditorSettingsStore = create<EditorSettingsState>((set, get) => ({
  ...EDITOR_SETTINGS.defaults,
  loaded: false,

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.settings.get(EDITOR_SETTINGS.key) as EditorSettings | null;
      if (settings) {
        set({ ...EDITOR_SETTINGS.defaults, ...settings, loaded: true });
      } else {
        set({ loaded: true });
      }
    } catch {
      set({ loaded: true });
    }
  },

  saveSettings: async (updates: Partial<EditorSettings>) => {
    const prev = { editorCommand: get().editorCommand, editorName: get().editorName };
    set(updates);
    try {
      const full = { editorCommand: get().editorCommand, editorName: get().editorName };
      await window.clubhouse.settings.save(EDITOR_SETTINGS.key, full);
    } catch {
      set(prev);
    }
  },
}));
