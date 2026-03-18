/**
 * Settings Definition — the single source of truth for a setting's type,
 * default values, and persistence filename.
 *
 * By defining a setting here, the IPC channel, handler, preload bridge,
 * and renderer store are all derived automatically — eliminating the
 * previous 6-file-change pattern.
 *
 * Usage:
 *   Main process:   createManagedSettings(CLIPBOARD_SETTINGS)
 *   Renderer:       createSettingsStore(CLIPBOARD_SETTINGS)
 *   Preload:        window.clubhouse.settings.get/save (generic, key-routed)
 */

/**
 * Defines a single settings domain (e.g., clipboard, badge, session).
 *
 * @template T - The shape of the settings object
 */
export interface SettingsDefinition<T> {
  /** Unique identifier used for IPC routing (e.g., 'clipboard', 'badge') */
  readonly key: string;
  /** JSON filename for persistence (e.g., 'clipboard-settings.json') */
  readonly filename: string;
  /** Default values when no persisted settings file exists */
  readonly defaults: T;
}

/** Derive IPC channel names from a settings key. */
export function settingsChannels(key: string) {
  return {
    get: `settings:${key}:get`,
    save: `settings:${key}:save`,
  };
}

// ---------------------------------------------------------------------------
// Concrete definitions — importable from both main and renderer
// ---------------------------------------------------------------------------

import type { ClipboardSettings, EditorSettings } from './types';

export const CLIPBOARD_SETTINGS: SettingsDefinition<ClipboardSettings> = {
  key: 'clipboard',
  filename: 'clipboard-settings.json',
  defaults: { clipboardCompat: false },
};

export const EDITOR_SETTINGS: SettingsDefinition<EditorSettings> = {
  key: 'editor',
  filename: 'editor-settings.json',
  defaults: { editorCommand: 'code', editorName: 'VS Code' },
};
