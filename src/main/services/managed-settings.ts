/**
 * Managed Settings — main-process factory that creates a settings store
 * and auto-registers IPC handlers from a single SettingsDefinition.
 *
 * This eliminates the need to:
 * - Create a separate settings service file
 * - Add IPC channel constants to ipc-channels.ts
 * - Register IPC handlers in app-handlers.ts
 * - Add preload bridge methods to preload/index.ts
 *
 * Usage:
 *   const clipboardSettings = createManagedSettings(CLIPBOARD_SETTINGS);
 *   clipboardSettings.getSettings();   // read current value
 *   clipboardSettings.saveSettings(v); // persist
 *
 * For settings with side effects on save:
 *   const updateSettings = createManagedSettings(UPDATE_SETTINGS, {
 *     onSave: (settings) => {
 *       if (settings.autoUpdate) startPeriodicChecks();
 *     },
 *   });
 */
import { ipcMain } from 'electron';
import { createSettingsStore, SettingsStore } from './settings-store';
import { SettingsDefinition, settingsChannels } from '../../shared/settings-definitions';

export interface ManagedSettings<T> {
  /** Read current settings from disk (with defaults fallback). */
  getSettings(): T;
  /** Persist settings to disk. */
  saveSettings(settings: T): void;
  /** The underlying SettingsStore (for advanced use: update, etc.). */
  store: SettingsStore<T>;
}

export interface ManagedSettingsOptions<T> {
  /** Called after settings are saved. Use for side effects (e.g., starting/stopping services). */
  onSave?: (settings: T, ...extraArgs: unknown[]) => void;
  /** Optional migration function for legacy settings format. */
  migrate?: (raw: Record<string, unknown>) => T;
  /** Override defaults at registration time (e.g., platform-dependent values). */
  defaultsOverride?: Partial<T>;
}

/**
 * Creates a settings service and registers IPC handlers in one call.
 *
 * The IPC channels are derived from the definition key:
 *   - `settings:{key}:get` — returns current settings
 *   - `settings:{key}:save` — persists settings (and triggers onSave)
 */
export function createManagedSettings<T>(
  definition: SettingsDefinition<T>,
  options?: ManagedSettingsOptions<T>,
): ManagedSettings<T> {
  const defaults = options?.defaultsOverride
    ? { ...definition.defaults, ...options.defaultsOverride }
    : definition.defaults;

  const store = createSettingsStore<T>(definition.filename, defaults, options?.migrate);
  const channels = settingsChannels(definition.key);

  ipcMain.handle(channels.get, () => store.get());

  ipcMain.handle(channels.save, (_event: Electron.IpcMainInvokeEvent, settings: T, ...extraArgs: unknown[]) => {
    store.save(settings);
    options?.onSave?.(settings, ...extraArgs);
  });

  return {
    getSettings: store.get,
    saveSettings: store.save,
    store,
  };
}
