import { create } from 'zustand';
import type { UpdateStatus, UpdateSettings, PendingReleaseNotes, VersionHistoryEntry } from '../../shared/types';

export const DISMISS_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

interface UpdateStoreState {
  status: UpdateStatus;
  settings: UpdateSettings;
  dismissed: boolean;
  whatsNew: PendingReleaseNotes | null;
  showWhatsNew: boolean;
  versionHistoryMarkdown: string | null;
  versionHistoryEntries: VersionHistoryEntry[];
  versionHistoryLoading: boolean;
  versionHistoryError: string | null;
  loadSettings: () => Promise<void>;
  saveSettings: (settings: UpdateSettings) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  applyUpdate: () => Promise<void>;
  dismiss: () => void;
  checkWhatsNew: () => Promise<void>;
  dismissWhatsNew: () => Promise<void>;
  loadVersionHistory: () => Promise<void>;
}

const DEFAULT_STATUS: UpdateStatus = {
  state: 'idle',
  availableVersion: null,
  releaseNotes: null,
  releaseMessage: null,
  downloadProgress: 0,
  error: null,
  downloadPath: null,
};

const DEFAULT_SETTINGS: UpdateSettings = {
  autoUpdate: true,
  previewChannel: false,
  lastCheck: null,
  dismissedVersion: null,
  lastSeenVersion: null,
};

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  status: DEFAULT_STATUS,
  settings: DEFAULT_SETTINGS,
  dismissed: false,
  whatsNew: null,
  showWhatsNew: false,
  versionHistoryMarkdown: null,
  versionHistoryEntries: [],
  versionHistoryLoading: false,
  versionHistoryError: null,

  loadSettings: async () => {
    try {
      const [settings, status] = await Promise.all([
        window.clubhouse.app.getUpdateSettings(),
        window.clubhouse.app.getUpdateStatus(),
      ]);
      set({
        settings: settings || DEFAULT_SETTINGS,
        status: status || DEFAULT_STATUS,
      });
    } catch {
      // Keep defaults on error
    }
  },

  saveSettings: async (settings: UpdateSettings) => {
    set({ settings });
    try {
      await window.clubhouse.app.saveUpdateSettings(settings);
    } catch {
      // Revert on error
    }
  },

  checkForUpdates: async () => {
    try {
      const status = await window.clubhouse.app.checkForUpdates();
      set({ status, dismissed: false });
    } catch {
      // Error handled in main process
    }
  },

  applyUpdate: async () => {
    try {
      await window.clubhouse.app.applyUpdate();
    } catch {
      // Error handled in main process
    }
  },

  dismiss: () => {
    set({ dismissed: true });
    // Re-show the banner after 4 hours
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      set({ dismissed: false });
      dismissTimer = null;
    }, DISMISS_DURATION_MS);
  },

  checkWhatsNew: async () => {
    try {
      const pending = await window.clubhouse.app.getPendingReleaseNotes();
      if (!pending) return;

      // Check if this is actually an upgrade (not a fresh install)
      const currentVersion = await window.clubhouse.app.getVersion();
      const { settings } = get();
      if (settings.lastSeenVersion === currentVersion) {
        // Same version — not an upgrade; clean up stale file
        await window.clubhouse.app.clearPendingReleaseNotes();
        return;
      }

      set({ whatsNew: pending, showWhatsNew: true });
    } catch {
      // Non-critical
    }
  },

  dismissWhatsNew: async () => {
    set({ whatsNew: null, showWhatsNew: false });
    try {
      await window.clubhouse.app.clearPendingReleaseNotes();
      const currentVersion = await window.clubhouse.app.getVersion();
      const { settings } = get();
      const updated = { ...settings, lastSeenVersion: currentVersion };
      set({ settings: updated });
      await window.clubhouse.app.saveUpdateSettings(updated);
    } catch {
      // Non-critical
    }
  },

  loadVersionHistory: async () => {
    set({ versionHistoryLoading: true, versionHistoryError: null });
    try {
      const result = await window.clubhouse.app.getVersionHistory();
      set({
        versionHistoryMarkdown: result.markdown,
        versionHistoryEntries: result.entries,
        versionHistoryLoading: false,
      });
    } catch (err) {
      set({
        versionHistoryLoading: false,
        versionHistoryError: err instanceof Error ? err.message : String(err),
      });
    }
  },
}));

// Listen for status updates from main process
export function initUpdateListener(): () => void {
  return window.clubhouse.app.onUpdateStatusChanged((status) => {
    useUpdateStore.setState({ status: status as UpdateStatus });
    // If a new version becomes ready, un-dismiss so the banner shows
    if (status.state === 'ready') {
      useUpdateStore.setState({ dismissed: false });
    }
  });
}
