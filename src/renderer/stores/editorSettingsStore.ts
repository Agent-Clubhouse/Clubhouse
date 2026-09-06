import { createSettingsStore } from './settings-store-factory';
import { EDITOR_SETTINGS } from '../../shared/settings-definitions';

export const useEditorSettingsStore = createSettingsStore(EDITOR_SETTINGS);
