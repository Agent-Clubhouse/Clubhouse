import { createSettingsStore } from './settings-store-factory';
import { GOOBERS_SETTINGS } from '../../shared/settings-definitions';

export const useGoobersSettingsStore = createSettingsStore(GOOBERS_SETTINGS);
