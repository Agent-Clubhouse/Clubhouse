import { createSettingsStore, peekStoredSettingsSync } from './settings-store';
import { isPreviewEligible } from './preview-eligible';
import { PREVIEW_ONLY_EXPERIMENTAL_FLAGS, STRUCTURED_MODE_REMOVED_NOTICE_KEY, type ExperimentalSettings } from '../../shared/types';

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

const FILENAME = 'experimental-settings.json';

const store = createSettingsStore<ExperimentalSettings>(FILENAME, {}, migrateExperimentalSettings, { audit: { key: 'experimental' } });

function pickFlags(settings: ExperimentalSettings, keep: (key: string) => boolean): ExperimentalSettings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => keep(key)));
}

const isPreviewOnly = (key: string): boolean => PREVIEW_ONLY_EXPERIMENTAL_FLAGS.includes(key);

/**
 * Whether there is a file and it can't be read. The store falls back to `{}`
 * then, which on its own looks the same as nothing saved: a graduated flag would
 * read as on when the person's saved false may be in that file.
 */
export function savedSettingsUnreadable(): boolean {
  return peekStoredSettingsSync(FILENAME) === 'unreadable';
}

/** What is saved, whatever this build honours. */
export const getStoredSettings = store.get;

/** The flags in force: in a build that isn't preview-eligible, the preview-only ones read as off. */
export function getSettings(): ExperimentalSettings {
  const saved = store.get();
  return isPreviewEligible() ? saved : pickFlags(saved, (key) => !isPreviewOnly(key));
}

/**
 * Save the flags. Callers write back what getSettings gave them, so in a build
 * that isn't preview-eligible the saved preview-only flags are kept as they are,
 * and turning Preview on later finds them again.
 */
export async function saveSettings(settings: ExperimentalSettings): Promise<void> {
  if (isPreviewEligible()) return store.save(settings);
  await store.update((saved) => ({
    ...pickFlags(settings, (key) => !isPreviewOnly(key)),
    ...pickFlags(saved, isPreviewOnly),
  }));
}
