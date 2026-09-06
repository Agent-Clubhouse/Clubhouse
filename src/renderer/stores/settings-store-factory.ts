/**
 * Settings Store Factory — creates a typed Zustand store from a SettingsDefinition.
 *
 * Eliminates the per-setting Zustand boilerplate by providing:
 * - Typed state matching the settings shape
 * - loadSettings() — fetches from main process via generic bridge
 * - saveSettings(updates) — optimistic update with error revert
 *
 * Usage:
 *   import { MCP_SETTINGS } from '../../shared/settings-definitions';
 *
 *   export const useMcpSettingsStore = createSettingsStore(MCP_SETTINGS);
 *
 *   // In a component:
 *   const enabled = useMcpSettingsStore(s => s.enabled);
 *   const save = useMcpSettingsStore(s => s.saveSettings);
 *   save({ enabled: true });
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { SettingsDefinition } from '../../shared/settings-definitions';

export interface SettingsStoreFactoryOptions<T extends object, U = Partial<T>> {
  /**
   * Resolve default values at runtime when a setting has domain-specific
   * initialization logic (for example, platform-dependent defaults).
   */
  getDefaults?: () => T;
  /** Normalize a store-specific save payload into the persisted settings shape. */
  normalizeUpdate?: (updates: U) => Partial<T>;
}

/** State shape produced by the factory: setting fields + load/save helpers. */
export type SettingsStoreState<T extends object, U = Partial<T>> = T & {
  /** Whether settings have been loaded from the main process at least once. */
  loaded: boolean;
  /** Fetch settings from the main process and update the store. */
  loadSettings: () => Promise<void>;
  /** Persist a partial update (optimistic with error revert). */
  saveSettings: (updates: U) => Promise<void>;
};

/**
 * Create a Zustand store for a managed setting.
 *
 * The store starts with the definition's defaults, then loadSettings()
 * fetches the persisted values from the main process via the generic
 * settings bridge (window.clubhouse.settings).
 */
export function createSettingsStore<T extends object, U = Partial<T>>(
  definition: SettingsDefinition<T>,
  options: SettingsStoreFactoryOptions<T, U> = {},
): UseBoundStore<StoreApi<SettingsStoreState<T, U>>> {
  const getDefaultState = () => ({
    ...(options.getDefaults ? options.getDefaults() : definition.defaults),
  }) as T;

  const normalizeUpdate = (updates: U): Partial<T> => {
    if (options.normalizeUpdate) {
      return options.normalizeUpdate(updates);
    }
    return updates as Partial<T>;
  };

  return create<SettingsStoreState<T, U>>()((set, get) => ({
    ...getDefaultState(),
    loaded: false,

    loadSettings: async () => {
      try {
        const settings = await window.clubhouse.settings.get(definition.key) as T | null;
        const defaults = getDefaultState() as Record<string, unknown>;
        if (settings) {
          const merged = { ...defaults, ...(settings as Record<string, unknown>), loaded: true };
          set(merged as unknown as Partial<SettingsStoreState<T, U>>);
        } else {
          set({ ...defaults, loaded: true } as unknown as Partial<SettingsStoreState<T, U>>);
        }
      } catch {
        const defaults = getDefaultState() as Record<string, unknown>;
        set({ ...defaults, loaded: true } as unknown as Partial<SettingsStoreState<T, U>>);
      }
    },

    saveSettings: async (updates: U) => {
      const next = normalizeUpdate(updates);
      const defaults = getDefaultState() as Record<string, unknown>;
      const prev: Record<string, unknown> = {};
      for (const key of Object.keys(defaults)) {
        prev[key] = (get() as Record<string, unknown>)[key];
      }

      set(next as Partial<SettingsStoreState<T, U>>);

      try {
        const full: Record<string, unknown> = {};
        for (const key of Object.keys(defaults)) {
          full[key] = (get() as Record<string, unknown>)[key];
        }
        await window.clubhouse.settings.save(definition.key, full as Record<string, unknown>);
      } catch {
        set(prev as unknown as Partial<SettingsStoreState<T, U>>);
      }
    },
  }));
}
