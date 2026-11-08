/**
 * The app-level source control provider (D61): what @@SourceControlProvider
 * becomes for an agent whose project and own settings don't set one. It used
 * to live in the Clubhouse Mode settings, which go away with Clubhouse Mode
 * (#2901). The startup pass copies the value there once; after that only
 * Agents & providers sets it. Until then the old value is read from
 * clubhouse-mode-settings.json (managed-agents/legacy-migration).
 */
import { createSettingsStore } from './settings-store';
import { readLegacyClubhouseModeSettings } from './managed-agents/legacy-migration';
import type { SourceControlProvider, SourceControlSettings } from '../../shared/types';
import { SOURCE_CONTROL_SETTINGS } from '../../shared/settings-definitions';

export type { SourceControlSettings };

const PROVIDERS: readonly SourceControlProvider[] = ['github', 'azure-devops'];

/** Also behind the generic settings bridge (settings-handlers.ts), for its row in Agents & providers. */
export const sourceControlSettingsStore = createSettingsStore<SourceControlSettings>(
  SOURCE_CONTROL_SETTINGS.filename,
  {},
  (raw) => (PROVIDERS.includes(raw.provider as SourceControlProvider) ? { provider: raw.provider as SourceControlProvider } : {}),
  { audit: { key: 'source_control', keys: ['provider'] } },
);

export const getSettings = sourceControlSettingsStore.get;
export const saveSettings = sourceControlSettingsStore.save;

export function getAppSourceControlProvider(): SourceControlProvider | undefined {
  return getSettings().provider;
}

/**
 * What the app level resolves to: this setting, then where Clubhouse Mode kept
 * it before (until the startup pass copies it), then GitHub.
 */
export function effectiveAppSourceControlProvider(): SourceControlProvider {
  return getAppSourceControlProvider() ?? readLegacyClubhouseModeSettings().sourceControlProvider ?? 'github';
}

export async function setAppSourceControlProvider(provider: SourceControlProvider): Promise<void> {
  if (!PROVIDERS.includes(provider) || getSettings().provider === provider) return;
  await saveSettings({ ...getSettings(), provider });
}
