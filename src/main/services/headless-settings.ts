import { createSettingsStore } from './settings-store';
import type { SpawnMode } from '../../shared/types';

export type { SpawnMode };

export interface HeadlessSettings {
  /** @deprecated Use `defaultMode` instead. Kept for migration from older settings. */
  enabled?: boolean;
  defaultMode?: SpawnMode;
  projectOverrides?: Record<string, SpawnMode>;
}

const store = createSettingsStore<HeadlessSettings>('headless-settings.json', {
  enabled: true,
});

export const getSettings = store.get;
export const saveSettings = store.save;

/** Resolve the effective default mode, migrating legacy `enabled` boolean. */
function resolveDefaultMode(settings: HeadlessSettings): SpawnMode {
  if (settings.defaultMode) return settings.defaultMode;
  // Legacy migration: enabled boolean → mode
  return settings.enabled !== false ? 'headless' : 'interactive';
}

export function getSpawnMode(projectPath?: string): SpawnMode {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath]) {
    return settings.projectOverrides[projectPath];
  }
  return resolveDefaultMode(settings);
}

export async function setProjectSpawnMode(projectPath: string, mode: SpawnMode): Promise<void> {
  const settings = getSettings();
  const overrides = { ...settings.projectOverrides, [projectPath]: mode };
  await saveSettings({ ...settings, projectOverrides: overrides });
}
