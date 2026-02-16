import { ThemeId } from '../../shared/types';
import { createSettingsStore } from './settings-store';

interface ThemeSettings {
  themeId: ThemeId;
}

const store = createSettingsStore<ThemeSettings>('theme-settings.json', {
  themeId: 'catppuccin-mocha',
});

export const getSettings = store.get;
export const saveSettings = store.save;
