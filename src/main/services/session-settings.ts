import { createSettingsStore } from './settings-store';

export interface SessionSettings {
  /** When true, prompt for a session name when a durable agent stops (default: false) */
  promptForName: boolean;
  /** Per-project overrides keyed by project path */
  projectOverrides?: Record<string, boolean>;
}

const store = createSettingsStore<SessionSettings>('session-settings.json', {
  promptForName: false,
}, undefined, { audit: { key: 'session' } });

export const getSettings = store.get;
export const saveSettings = store.save;
