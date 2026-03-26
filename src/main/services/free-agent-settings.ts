import { createSettingsStore } from './settings-store';
import type { FreeAgentPermissionMode } from '../../shared/types';

export type { FreeAgentPermissionMode };

export interface FreeAgentSettings {
  defaultMode: FreeAgentPermissionMode;
  projectOverrides?: Record<string, FreeAgentPermissionMode>;
}

const store = createSettingsStore<FreeAgentSettings>('free-agent-settings.json', {
  defaultMode: 'auto',
});

export const getSettings = store.get;
export const saveSettings = store.save;

export function getPermissionMode(projectPath?: string): FreeAgentPermissionMode {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath]) {
    return settings.projectOverrides[projectPath];
  }
  return settings.defaultMode;
}
