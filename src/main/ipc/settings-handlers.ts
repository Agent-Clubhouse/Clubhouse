/**
 * Settings Handlers — registers all managed settings.
 *
 * Each managed setting is created at module level (safe — no side effects),
 * then `.register()` is called inside registerSettingsHandlers() to bind
 * the IPC handlers at the correct time during bootstrap.
 *
 * To add a new setting:
 * 1. Define a SettingsDefinition with key, filename, and defaults
 * 2. Call createManagedSettings() at module level
 * 3. Call .register() inside registerSettingsHandlers()
 * 4. Create a renderer store with createSettingsStore() in the renderer
 * That's it — no IPC channels, handler registration, or preload changes needed.
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
//   export const fooSettings = createManagedSettings(FOO_DEF, {
//     onSave: (settings) => { /* side effects */ },
//   });
// Then add fooSettings.register() inside registerSettingsHandlers().
// ---------------------------------------------------------------------------

/** Register all managed settings IPC handlers. */
export function registerSettingsHandlers(): void {
  clipboardSettings.register();
}
