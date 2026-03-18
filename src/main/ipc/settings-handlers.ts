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
import { CLIPBOARD_SETTINGS, EDITOR_SETTINGS } from '../../shared/settings-definitions';

export { CLIPBOARD_SETTINGS, EDITOR_SETTINGS };

export const clipboardSettings = createManagedSettings(CLIPBOARD_SETTINGS, {
  defaultsOverride: {
    clipboardCompat: process.platform === 'win32',
  },
});

export const editorSettings = createManagedSettings(EDITOR_SETTINGS);

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
  editorSettings.register();
}
