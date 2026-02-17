import { createSettingsStore } from './settings-store';

export type SpawnMode = 'headless' | 'interactive';

export interface HeadlessSettings {
  enabled: boolean;
  projectOverrides?: Record<string, SpawnMode>;
}

const store = createSettingsStore<HeadlessSettings>('headless-settings.json', {
  enabled: false,
});

export const getSettings = store.get;
export const saveSettings = store.save;

export function getSpawnMode(projectPath?: string): SpawnMode {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath]) {
    return settings.projectOverrides[projectPath];
  }
  return settings.enabled ? 'headless' : 'interactive';
}

export function setProjectSpawnMode(projectPath: string, mode: SpawnMode): void {
  const settings = getSettings();
  const overrides = { ...settings.projectOverrides, [projectPath]: mode };
  saveSettings({ ...settings, projectOverrides: overrides });
}
