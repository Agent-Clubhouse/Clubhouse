import { createSettingsStore } from './settings-store';
import type { SpawnMode } from '../../shared/types';

export type { SpawnMode };

export interface HeadlessSettings {
  /** @deprecated Use `defaultMode` instead. Kept for migration from older settings. */
  enabled?: boolean;
  defaultMode?: SpawnMode;
  projectOverrides?: Record<string, SpawnMode>;
}

/**
 * Map any spawn mode that no longer exists (the removed `structured` mode) to
 * `interactive`, so those quick agents run in the terminal.
 */
function normalizeMode(mode: unknown): SpawnMode | undefined {
  if (mode === 'headless' || mode === 'interactive') return mode;
  return mode === undefined ? undefined : 'interactive';
}

export function migrateHeadlessSettings(raw: Record<string, unknown>): HeadlessSettings {
  const settings = { ...raw } as HeadlessSettings & Record<string, unknown>;
  if (settings.defaultMode !== undefined) settings.defaultMode = normalizeMode(settings.defaultMode);
  if (settings.projectOverrides) {
    const overrides: Record<string, SpawnMode> = {};
    for (const [projectPath, mode] of Object.entries(settings.projectOverrides)) {
      const normalized = normalizeMode(mode);
      if (normalized) overrides[projectPath] = normalized;
    }
    settings.projectOverrides = overrides;
  }
  return settings;
}

const store = createSettingsStore<HeadlessSettings>('headless-settings.json', {
  enabled: true,
}, migrateHeadlessSettings);

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
