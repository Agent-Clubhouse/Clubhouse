import { createSettingsStore } from './settings-store-factory';
import { SECURITY_SETTINGS } from '../../shared/settings-definitions';

export const useSecuritySettingsStore = createSettingsStore(SECURITY_SETTINGS);
