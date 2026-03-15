import { createSettingsStore } from './settings-store';
import { ClubhouseModeSettings } from '../../shared/types';

const store = createSettingsStore<ClubhouseModeSettings>('clubhouse-mode-settings.json', {
  enabled: false,
});

export const getSettings = store.get;
export const saveSettings = store.save;

export function isClubhouseModeEnabled(projectPath?: string): boolean {
  const settings = getSettings();
  if (projectPath && settings.projectOverrides?.[projectPath] !== undefined) {
    return settings.projectOverrides[projectPath];
  }
  return settings.enabled;
}

export async function setProjectOverride(projectPath: string, enabled: boolean): Promise<void> {
  const settings = getSettings();
  const overrides = { ...settings.projectOverrides, [projectPath]: enabled };
  await saveSettings({ ...settings, projectOverrides: overrides });
}

export async function clearProjectOverride(projectPath: string): Promise<void> {
  const settings = getSettings();
  if (!settings.projectOverrides) return;
  const { [projectPath]: _, ...rest } = settings.projectOverrides;
  await saveSettings({ ...settings, projectOverrides: Object.keys(rest).length > 0 ? rest : undefined });
}
