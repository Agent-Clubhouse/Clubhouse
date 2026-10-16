import { createSettingsStore } from './settings-store';
import { STRUCTURED_MODE_REMOVED_NOTICE_KEY, type ExperimentalSettings } from '../../shared/types';

/**
 * Drop the removed `structuredMode` flag. Agents that used structured mode now
 * run in the terminal; if the flag was on, leave a marker so the renderer can
 * tell the user once. Saving the migrated settings removes the old key from disk.
 */
export function migrateExperimentalSettings(raw: Record<string, unknown>): ExperimentalSettings {
  const settings = { ...raw };
  if ('structuredMode' in settings) {
    if (settings.structuredMode === true) settings[STRUCTURED_MODE_REMOVED_NOTICE_KEY] = true;
    delete settings.structuredMode;
  }
  return settings as ExperimentalSettings;
}

const store = createSettingsStore<ExperimentalSettings>('experimental-settings.json', {}, migrateExperimentalSettings);

export const getSettings = store.get;
export const saveSettings = store.save;
