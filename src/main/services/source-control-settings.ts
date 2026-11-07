/**
 * The app-level source control provider (D61): what @@SourceControlProvider
 * becomes for an agent whose project and own settings don't set one. It used
 * to live in the Clubhouse Mode settings, which go away with Clubhouse Mode
 * (#2901). The value there is copied here once, and a save of the Clubhouse
 * Mode settings that carries one is kept here too, so both say the same until
 * the old place is removed.
 */
import { createSettingsStore } from './settings-store';
import type { SourceControlProvider } from '../../shared/types';

export interface SourceControlSettings {
  provider?: SourceControlProvider;
}

const PROVIDERS: readonly SourceControlProvider[] = ['github', 'azure-devops'];

const store = createSettingsStore<SourceControlSettings>(
  'source-control-settings.json',
  {},
  (raw) => (PROVIDERS.includes(raw.provider as SourceControlProvider) ? { provider: raw.provider as SourceControlProvider } : {}),
  { audit: { key: 'source_control', keys: ['provider'] } },
);

export const getSettings = store.get;
export const saveSettings = store.save;

export function getAppSourceControlProvider(): SourceControlProvider | undefined {
  return getSettings().provider;
}

export async function setAppSourceControlProvider(provider: SourceControlProvider): Promise<void> {
  if (!PROVIDERS.includes(provider) || getSettings().provider === provider) return;
  await saveSettings({ ...getSettings(), provider });
}
