import { createSettingsStore } from './settings-store';
import type { ClipboardSettings } from '../../shared/types';

// Default clipboard compatibility to enabled on Windows where it is required
const store = createSettingsStore<ClipboardSettings>('clipboard-settings.json', {
  clipboardCompat: process.platform === 'win32',
});

export const getSettings = store.get;
export const saveSettings = store.save;
