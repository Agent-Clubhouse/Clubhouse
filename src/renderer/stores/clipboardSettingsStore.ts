import { create } from 'zustand';
import type { ClipboardSettings } from '../../shared/types';
import { CLIPBOARD_SETTINGS } from '../../shared/settings-definitions';

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
      const settings = await window.clubhouse.settings.get(CLIPBOARD_SETTINGS.key) as ClipboardSettings | null;
      set({ clipboardCompat: settings?.clipboardCompat ?? defaultClipboardCompat(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  saveSettings: async (clipboardCompat: boolean) => {
    const prev = get().clipboardCompat;
    set({ clipboardCompat });
    try {
      await window.clubhouse.settings.save(CLIPBOARD_SETTINGS.key, { clipboardCompat });
    } catch {
      set({ clipboardCompat: prev });
    }
  },
}));
