import { createSettingsStore } from './settings-store-factory';
import { CLIPBOARD_SETTINGS, isClipboardCompatPlatform } from '../../shared/settings-definitions';

export const getClipboardCompatDefault = (platform: string = window.clubhouse.platform): boolean =>
  isClipboardCompatPlatform(platform);

export const useClipboardSettingsStore = createSettingsStore(CLIPBOARD_SETTINGS, {
  getDefaults: () => ({
    clipboardCompat: getClipboardCompatDefault(),
  }),
  normalizeUpdate: (clipboardCompat: boolean) => ({ clipboardCompat }),
});
