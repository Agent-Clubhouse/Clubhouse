/**
 * The app-level source control provider (D61), kept in its own settings file
 * since Clubhouse Mode's settings go away (#2901). Uses the managed settings
 * factory (no custom IPC).
 */
import { createSettingsStore } from './settings-store-factory';
import { SOURCE_CONTROL_SETTINGS } from '../../shared/settings-definitions';

export const useSourceControlSettingsStore = createSettingsStore(SOURCE_CONTROL_SETTINGS);
