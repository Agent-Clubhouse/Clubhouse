import { createSettingsStore } from './settings-store';
import type { AgentExecutionMode } from '../orchestrators/types';

export interface OrchestratorSettings {
  enabled: string[];
  /** Per-provider default execution mode preference */
  defaultExecutionMode?: Partial<Record<string, AgentExecutionMode>>;
}

const store = createSettingsStore<OrchestratorSettings>('orchestrator-settings.json', {
  enabled: ['claude-code'],
});

export const getSettings = store.get;
export const saveSettings = store.save;
