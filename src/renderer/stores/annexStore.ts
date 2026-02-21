import { create } from 'zustand';
import type { AnnexSettings, AnnexStatus } from '../../shared/types';

const DEFAULT_SETTINGS: AnnexSettings = {
  enabled: false,
  deviceName: '',
};

const DEFAULT_STATUS: AnnexStatus = {
  advertising: false,
  port: 0,
  pin: '',
  connectedCount: 0,
};

interface AnnexStoreState {
  settings: AnnexSettings;
  status: AnnexStatus;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: AnnexSettings) => Promise<void>;
  loadStatus: () => Promise<void>;
  regeneratePin: () => Promise<void>;
}

export const useAnnexStore = create<AnnexStoreState>((set) => ({
  settings: DEFAULT_SETTINGS,
  status: DEFAULT_STATUS,

  loadSettings: async () => {
    try {
      const [settings, status] = await Promise.all([
        window.clubhouse.annex.getSettings(),
        window.clubhouse.annex.getStatus(),
      ]);
      set({
        settings: settings || DEFAULT_SETTINGS,
        status: status || DEFAULT_STATUS,
      });
    } catch {
      // Keep defaults
    }
  },

  saveSettings: async (settings: AnnexSettings) => {
    set({ settings });
    try {
      await window.clubhouse.annex.saveSettings(settings);
      // Status will be pushed via onStatusChanged
    } catch {
      // Revert on error
    }
  },

  loadStatus: async () => {
    try {
      const status = await window.clubhouse.annex.getStatus();
      set({ status: status || DEFAULT_STATUS });
    } catch {
      // Keep defaults
    }
  },

  regeneratePin: async () => {
    try {
      const status = await window.clubhouse.annex.regeneratePin();
      set({ status: status || DEFAULT_STATUS });
    } catch {
      // Error handled in main
    }
  },
}));

/** Listen for status updates pushed from main process. */
export function initAnnexListener(): () => void {
  return window.clubhouse.annex.onStatusChanged((status) => {
    useAnnexStore.setState({ status: status as AnnexStatus });
  });
}
