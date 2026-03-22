import { create } from 'zustand';
import type { SecuritySettings } from '../../shared/types';
import { SECURITY_SETTINGS } from '../../shared/settings-definitions';

interface SecuritySettingsState {
  allowLocalFileWebviews: boolean;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: Partial<SecuritySettings>) => Promise<void>;
}

export const useSecuritySettingsStore = create<SecuritySettingsState>((set, get) => ({
  allowLocalFileWebviews: false,
  loaded: false,

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.settings.get(SECURITY_SETTINGS.key) as SecuritySettings | null;
      set({ allowLocalFileWebviews: settings?.allowLocalFileWebviews ?? false, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveSettings: async (partial: Partial<SecuritySettings>) => {
    const prev = get().allowLocalFileWebviews;
    const next = partial.allowLocalFileWebviews ?? prev;
    set({ allowLocalFileWebviews: next });
    try {
      await window.clubhouse.settings.save(SECURITY_SETTINGS.key, { allowLocalFileWebviews: next });
    } catch {
      set({ allowLocalFileWebviews: prev });
    }
  },
}));
