import { create } from 'zustand';
import type { HookServerSettings } from '../../shared/types';
import { HOOK_SERVER_SETTINGS } from '../../shared/settings-definitions';

interface HookServerSettingsState {
  enabled: boolean;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: Partial<HookServerSettings>) => Promise<void>;
}

export const useHookServerSettingsStore = create<HookServerSettingsState>((set, get) => ({
  enabled: HOOK_SERVER_SETTINGS.defaults.enabled,
  loaded: false,

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.settings.get(HOOK_SERVER_SETTINGS.key) as HookServerSettings | null;
      set({ enabled: settings?.enabled ?? HOOK_SERVER_SETTINGS.defaults.enabled, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveSettings: async (partial: Partial<HookServerSettings>) => {
    const prev = get().enabled;
    const next = partial.enabled ?? prev;
    set({ enabled: next });
    try {
      await window.clubhouse.settings.save(HOOK_SERVER_SETTINGS.key, { enabled: next });
    } catch {
      set({ enabled: prev });
    }
  },
}));
