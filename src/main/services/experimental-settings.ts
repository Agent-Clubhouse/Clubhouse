import { createSettingsStore } from './settings-store';
import type { ExperimentalSettings } from '../../shared/types';

const store = createSettingsStore<ExperimentalSettings>('experimental-settings.json', {});

export const getSettings = store.get;
export const saveSettings = store.save;

/** Flags for features that have been promoted out of experimental. */
const STALE_FLAGS = ['annex'];

/** Remove persisted flags for features that are no longer experimental. */
export async function cleanupStaleFlags(): Promise<void> {
  const settings = store.get();
  const staleKeys = STALE_FLAGS.filter((key) => key in settings);
  if (staleKeys.length === 0) return;

  const cleaned = { ...settings };
  for (const key of staleKeys) {
    delete cleaned[key];
  }
  await store.save(cleaned);
}
