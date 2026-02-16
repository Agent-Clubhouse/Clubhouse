import { createSettingsStore } from './settings-store';

export interface OrchestratorSettings {
  enabled: string[];
}

const store = createSettingsStore<OrchestratorSettings>('orchestrator-settings.json', {
  enabled: ['claude-code'],
});

export const getSettings = store.get;
export const saveSettings = store.save;
