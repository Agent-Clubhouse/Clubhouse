import { createSettingsStore } from './settings-store';
import type { ExperimentalSettings } from '../../shared/types';

const store = createSettingsStore<ExperimentalSettings>('experimental-settings.json', {});

export const getSettings = store.get;
export const saveSettings = store.save;
