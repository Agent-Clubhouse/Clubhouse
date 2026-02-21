import { create } from 'zustand';

function defaultClipboardCompat(): boolean {
  return window.clubhouse.platform === 'win32';
}

interface ClipboardSettingsState {
  clipboardCompat: boolean;
  loaded: boolean;
  loadSettings: () => Promise<void>;
  saveSettings: (clipboardCompat: boolean) => Promise<void>;
}

export const useClipboardSettingsStore = create<ClipboardSettingsState>((set, get) => ({
  clipboardCompat: false,
  loaded: false,

  loadSettings: async () => {
    try {
      const settings = await window.clubhouse.app.getClipboardSettings();
      set({ clipboardCompat: settings?.clipboardCompat ?? defaultClipboardCompat(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveSettings: async (clipboardCompat: boolean) => {
    const prev = get().clipboardCompat;
    set({ clipboardCompat });
    try {
      window.clubhouse.app.saveClipboardSettings({ clipboardCompat });
    } catch {
      set({ clipboardCompat: prev });
    }
  },
}));
