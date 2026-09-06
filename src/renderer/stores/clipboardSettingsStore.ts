import { createSettingsStore } from './settings-store-factory';
import { CLIPBOARD_SETTINGS } from '../../shared/settings-definitions';

export const useClipboardSettingsStore = createSettingsStore(CLIPBOARD_SETTINGS, {
  getDefaults: () => ({
    clipboardCompat: window.clubhouse.platform === 'win32',
  }),
  normalizeUpdate: (clipboardCompat: boolean) => ({ clipboardCompat }),
});
