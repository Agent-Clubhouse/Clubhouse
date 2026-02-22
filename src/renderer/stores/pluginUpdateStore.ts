import { create } from 'zustand';
import type { PluginUpdateInfo, PluginUpdatesStatus } from '../../shared/marketplace-types';
import { hotReloadPlugin } from '../plugins/plugin-loader';

export const DISMISS_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

let dismissTimer: ReturnType<typeof setTimeout> | null = null;

interface PluginUpdateStoreState {
  updates: PluginUpdateInfo[];
  checking: boolean;
  lastCheck: string | null;
  updating: Record<string, string>; // pluginId -> phase
  error: string | null;
  dismissed: boolean;

  checkForUpdates: () => Promise<void>;
  updatePlugin: (pluginId: string) => Promise<{ success: boolean; newVersion?: string; error?: string }>;
  updateAll: () => Promise<void>;
  dismiss: () => void;
}

const DEFAULT_STATUS: PluginUpdatesStatus = {
  updates: [],
  checking: false,
  lastCheck: null,
  updating: {},
  error: null,
};

export const usePluginUpdateStore = create<PluginUpdateStoreState>((set, get) => ({
  ...DEFAULT_STATUS,
  dismissed: false,

  checkForUpdates: async () => {
    set({ checking: true, error: null });
    try {
      const result = await window.clubhouse.marketplace.checkPluginUpdates();
      set({
        updates: result.updates,
        checking: false,
        lastCheck: result.checkedAt,
        dismissed: false, // Show banner when new updates found
      });
    } catch {
      set({ checking: false });
    }
  },

  updatePlugin: async (pluginId: string) => {
    set((s) => ({
      updating: { ...s.updating, [pluginId]: 'downloading' },
    }));

    try {
      const result = await window.clubhouse.marketplace.updatePlugin({ pluginId });

      if (result.success) {
        // Hot-reload the plugin without restarting the app
        set((s) => ({
          updating: { ...s.updating, [pluginId]: 'reloading' },
        }));

        try {
          await hotReloadPlugin(pluginId);
        } catch {
          // Hot-reload failed — plugin will need manual restart
          // but the files are already updated on disk
        }

        // Remove from updates list
        set((s) => {
          const { [pluginId]: _, ...restUpdating } = s.updating;
          return {
            updates: s.updates.filter((u) => u.pluginId !== pluginId),
            updating: restUpdating,
          };
        });
      } else {
        set((s) => {
          const { [pluginId]: _, ...restUpdating } = s.updating;
          return { updating: restUpdating, error: result.error || 'Update failed' };
        });
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => {
        const { [pluginId]: _, ...restUpdating } = s.updating;
        return { updating: restUpdating, error: msg };
      });
      return { success: false, error: msg };
    }
  },

  updateAll: async () => {
    const { updates, updatePlugin } = get();
    for (const update of updates) {
      await updatePlugin(update.pluginId);
    }
  },

  dismiss: () => {
    set({ dismissed: true });
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
      set({ dismissed: false });
      dismissTimer = null;
    }, DISMISS_DURATION_MS);
  },
}));

/** Listen for plugin update status changes from the main process. */
export function initPluginUpdateListener(): () => void {
  return window.clubhouse.marketplace.onPluginUpdatesChanged((status) => {
    const store = usePluginUpdateStore.getState();
    usePluginUpdateStore.setState({
      updates: status.updates,
      checking: status.checking,
      lastCheck: status.lastCheck,
      updating: status.updating,
      error: status.error,
    });
    // Un-dismiss when new updates arrive
    if (status.updates.length > 0 && !store.checking) {
      usePluginUpdateStore.setState({ dismissed: false });
    }
  });
}
