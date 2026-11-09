import { createSettingsStore } from './settings-store';
import type { UpdateSettings } from '../../shared/types';

/**
 * The saved update settings, including the Preview opt-in. Kept apart from
 * auto-update-service so isPreviewEligible, which every experimental flag read
 * now goes through, doesn't pull the updater and its imports into that path.
 */
const settingsStore = createSettingsStore<UpdateSettings>('update-settings.json', {
  autoUpdate: true,
  previewChannel: false,
  lastCheck: null,
  lastCheckError: null,
  dismissedVersion: null,
  lastSeenVersion: null,
}, undefined, { audit: { key: 'update', ignore: ['lastCheck', 'lastCheckError', 'dismissedVersion', 'lastSeenVersion'] } });

export const getSettings = settingsStore.get;
export const saveSettings = settingsStore.save;
