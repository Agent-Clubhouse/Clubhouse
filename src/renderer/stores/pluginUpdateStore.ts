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
  /** Per-plugin error messages for failed updates (pluginId -> error). */
  updateErrors: Record<string, string>;
  dismissed: boolean;

  checkForUpdates: () => Promise<void>;
  updatePlugin: (pluginId: string) => Promise<{ success: boolean; newVersion?: string; error?: string }>;
  updateAll: () => Promise<void>;
  dismiss: () => void;
  clearUpdateError: (pluginId: string) => void;
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
  updateErrors: {},
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
    // Clear any previous error for this plugin
    set((s) => {
      const { [pluginId]: _, ...restErrors } = s.updateErrors;
      return {
        updating: { ...s.updating, [pluginId]: 'downloading' },
        updateErrors: restErrors,
      };
    });

    try {
      const result = await window.clubhouse.marketplace.updatePlugin({ pluginId });

      if (result.success) {
        // Hot-reload the plugin without restarting the app
        set((s) => ({
          updating: { ...s.updating, [pluginId]: 'reloading' },
        }));

        try {
          await hotReloadPlugin(pluginId);
        } catch (reloadErr) {
          // Hot-reload failed — files are updated on disk but the plugin
          // didn't re-activate. Track the error so the user knows.
          const reloadMsg = reloadErr instanceof Error ? reloadErr.message : String(reloadErr);
          set((s) => {
            const { [pluginId]: _, ...restUpdating } = s.updating;
            return {
              updating: restUpdating,
              updateErrors: { ...s.updateErrors, [pluginId]: reloadMsg },
            };
          });

          // Remove from updates list since files are updated, but return
          // a partial-success result so the banner can show the reload error.
          set((s) => ({
            updates: s.updates.filter((u) => u.pluginId !== pluginId),
          }));

          return { success: true, newVersion: result.newVersion, error: reloadMsg };
        }

        // Full success — remove from updates list and clear updating state
        set((s) => {
          const { [pluginId]: _, ...restUpdating } = s.updating;
          return {
            updates: s.updates.filter((u) => u.pluginId !== pluginId),
            updating: restUpdating,
          };
        });
      } else {
        // Download/install failed — keep in updates list so user can retry
        set((s) => {
          const { [pluginId]: _, ...restUpdating } = s.updating;
          return {
            updating: restUpdating,
            updateErrors: { ...s.updateErrors, [pluginId]: result.error || 'Update failed' },
          };
        });
      }

      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set((s) => {
        const { [pluginId]: _, ...restUpdating } = s.updating;
        return {
          updating: restUpdating,
          updateErrors: { ...s.updateErrors, [pluginId]: msg },
        };
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

  clearUpdateError: (pluginId: string) => {
    set((s) => {
      const { [pluginId]: _, ...rest } = s.updateErrors;
      return { updateErrors: rest };
    });
  },
}));

/** Listen for plugin update status changes from the main process. */
export function initPluginUpdateListener(): () => void {
  return window.clubhouse.marketplace.onPluginUpdatesChanged((status) => {
    const store = usePluginUpdateStore.getState();

    // Don't overwrite local `updating` state while the renderer is actively
    // performing an update — the local state is more authoritative since it
    // includes the hot-reload phase which the main process doesn't track.
    const hasLocalUpdates = Object.keys(store.updating).length > 0;
    usePluginUpdateStore.setState({
      updates: status.updates,
      checking: status.checking,
      lastCheck: status.lastCheck,
      updating: hasLocalUpdates ? store.updating : status.updating,
      error: status.error,
    });
    // Un-dismiss when new updates arrive
    if (status.updates.length > 0 && !store.checking) {
      usePluginUpdateStore.setState({ dismissed: false });
    }
  });
}
