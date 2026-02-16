import { create } from 'zustand';

interface HeadlessState {
  enabled: boolean;
  loadSettings: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export const useHeadlessStore = create<HeadlessState>((set, get) => ({
  enabled: false,

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getHeadlessSettings();
      set({ enabled: settings?.enabled ?? false });
    } catch {
      // Keep default
    }
  },

  setEnabled: async (enabled) => {
    const prev = get().enabled;
    set({ enabled });
    try {
      await window.clubhouse.app.saveHeadlessSettings({ enabled });
    } catch {
      set({ enabled: prev });
    }
  },
}));
