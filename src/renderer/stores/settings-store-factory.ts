/**
 * Settings Store Factory — creates a typed Zustand store from a SettingsDefinition.
 *
 * Eliminates the per-setting Zustand boilerplate by providing:
 * - Typed state matching the settings shape
 * - loadSettings() — fetches from main process via generic bridge
 * - saveSettings(updates) — optimistic update with error revert
 *
 * Usage:
 *   import { CLIPBOARD_SETTINGS } from '../../main/ipc/settings-handlers';
 *
 *   export const useClipboardSettingsStore = createSettingsStore(CLIPBOARD_SETTINGS);
 *
 *   // In a component:
 *   const compat = useClipboardSettingsStore(s => s.clipboardCompat);
 *   const save = useClipboardSettingsStore(s => s.saveSettings);
 *   save({ clipboardCompat: true });
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { SettingsDefinition } from '../../shared/settings-definitions';

/** State shape produced by the factory: setting fields + load/save helpers. */
export type SettingsStoreState<T> = T & {
  /** Whether settings have been loaded from the main process at least once. */
  loaded: boolean;
  /** Fetch settings from the main process and update the store. */
  loadSettings: () => Promise<void>;
  /** Persist a partial update (optimistic with error revert). */
  saveSettings: (updates: Partial<T>) => Promise<void>;
};

/**
 * Create a Zustand store for a managed setting.
 *
 * The store starts with the definition's defaults, then loadSettings()
 * fetches the persisted values from the main process via the generic
 * settings bridge (window.clubhouse.settings).
 */
export function createSettingsStore<T extends Record<string, unknown>>(
  definition: SettingsDefinition<T>,
): UseBoundStore<StoreApi<SettingsStoreState<T>>> {
  return create<SettingsStoreState<T>>()((set, get) => ({
    ...definition.defaults,
    loaded: false,

    loadSettings: async () => {
      try {
        const settings = await window.clubhouse.settings.get(definition.key) as T | null;
        if (settings) {
          set({ ...definition.defaults, ...settings, loaded: true } as unknown as Partial<SettingsStoreState<T>>);
        } else {
          set({ loaded: true } as Partial<SettingsStoreState<T>>);
        }
      } catch {
        set({ loaded: true } as Partial<SettingsStoreState<T>>);
      }
    },

    saveSettings: async (updates: Partial<T>) => {
      // Snapshot current state for revert
      const prev: Record<string, unknown> = {};
      for (const key of Object.keys(definition.defaults)) {
        prev[key] = (get() as Record<string, unknown>)[key];
      }

      // Optimistic update
      set(updates as Partial<SettingsStoreState<T>>);

      try {
        // Build full settings object for persistence
        const full: Record<string, unknown> = {};
        for (const key of Object.keys(definition.defaults)) {
          full[key] = (get() as Record<string, unknown>)[key];
        }
        await window.clubhouse.settings.save(definition.key, full as T);
      } catch {
        // Revert on error
        set(prev as Partial<SettingsStoreState<T>>);
      }
    },
  }));
}
