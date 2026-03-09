/**
 * Settings Handlers — registers all managed settings.
 *
 * Each call to createManagedSettings() auto-registers IPC handlers,
 * so this file only needs to invoke the factory for each setting.
 *
 * To add a new setting:
 * 1. Define it in shared/settings-definitions.ts (type + key + filename + defaults)
 * 2. Call createManagedSettings() here
 * 3. Create a renderer store with createSettingsStore() in the renderer
 * That's it — no IPC channels, handlers, or preload changes needed.
 */
import { createManagedSettings } from '../services/managed-settings';
import type { SettingsDefinition } from '../../shared/settings-definitions';
import type { ClipboardSettings } from '../../shared/types';

// ---------------------------------------------------------------------------
// Clipboard Settings
// ---------------------------------------------------------------------------
export const CLIPBOARD_SETTINGS: SettingsDefinition<ClipboardSettings> = {
  key: 'clipboard',
  filename: 'clipboard-settings.json',
  defaults: { clipboardCompat: false },
};

export const clipboardSettings = createManagedSettings(CLIPBOARD_SETTINGS, {
  defaultsOverride: {
    clipboardCompat: process.platform === 'win32',
  },
});

// ---------------------------------------------------------------------------
// To migrate more settings, add them here following the same pattern.
// For settings with side effects on save, use the onSave option:
//
//   export const updateSettings = createManagedSettings(UPDATE_SETTINGS_DEF, {
//     onSave: (settings) => {
//       if (settings.autoUpdate) startPeriodicChecks();
//       else stopPeriodicChecks();
//     },
//   });
// ---------------------------------------------------------------------------

/** Register all managed settings IPC handlers. */
export function registerSettingsHandlers(): void {
  // All handlers are registered as a side effect of createManagedSettings()
  // calls above (module-level). This function exists so that the registration
  // timing is explicit in the handler bootstrap sequence and to ensure the
  // module is imported (triggering the side effects).
}
