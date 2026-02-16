import { createSettingsStore } from './settings-store';

export interface HeadlessSettings {
  enabled: boolean;
}

const store = createSettingsStore<HeadlessSettings>('headless-settings.json', {
  enabled: false,
});

export const getSettings = store.get;
export const saveSettings = store.save;
