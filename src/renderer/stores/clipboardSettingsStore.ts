import { createSettingsStore } from './settings-store-factory';
import { CLIPBOARD_SETTINGS, isClipboardCompatPlatform } from '../../shared/settings-definitions';

export const useClipboardSettingsStore = createSettingsStore(CLIPBOARD_SETTINGS, {
  getDefaults: () => ({
    clipboardCompat: isClipboardCompatPlatform(window.clubhouse.platform),
  }),
  normalizeUpdate: (clipboardCompat: boolean) => ({ clipboardCompat }),
});
