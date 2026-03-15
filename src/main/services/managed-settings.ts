/**
 * Managed Settings — main-process factory that creates a settings store
 * and provides a deferred IPC registration function.
 *
 * This eliminates the need to:
 * - Create a separate settings service file
 * - Add IPC channel constants to ipc-channels.ts
 * - Register IPC handlers in app-handlers.ts
 * - Add preload bridge methods to preload/index.ts
 *
 * Usage:
 *   // Define (safe at module level — no side effects)
 *   const clipboardSettings = createManagedSettings(CLIPBOARD_SETTINGS);
 *
 *   // Register IPC (call during handler bootstrap)
 *   clipboardSettings.register();
 *
 *   // Use
 *   clipboardSettings.getSettings();
 *   await clipboardSettings.saveSettings(v);
 *
 * For settings with side effects on save:
 *   const updateSettings = createManagedSettings(UPDATE_SETTINGS, {
 *     onSave: (settings) => {
 *       if (settings.autoUpdate) void startPeriodicChecks();
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
  saveSettings(settings: T): Promise<void>;
  /** The underlying SettingsStore (for advanced use: update, etc.). */
  store: SettingsStore<T>;
  /** Register IPC handlers. Call once during handler bootstrap. */
  register(): void;
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
 * Creates a settings service with deferred IPC registration.
 *
 * The store is created immediately (safe at module load), but IPC handlers
 * are only registered when `.register()` is called. This avoids triggering
 * `ipcMain.handle` during module import, which breaks tests that need to
 * capture handlers via mock setup.
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

  let registered = false;

  return {
    getSettings: store.get,
    saveSettings: store.save,
    store,
    register() {
      if (registered) return;
      registered = true;

      const channels = settingsChannels(definition.key);

      ipcMain.handle(channels.get, () => store.get());

      ipcMain.handle(channels.save, async (_event: Electron.IpcMainInvokeEvent, settings: T, ...extraArgs: unknown[]) => {
        await store.save(settings);
        options?.onSave?.(settings, ...extraArgs);
      });
    },
  };
}
