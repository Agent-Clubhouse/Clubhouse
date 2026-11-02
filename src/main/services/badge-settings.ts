import { createSettingsStore } from './settings-store';
import type { BadgeSettings } from '../../shared/types';

const store = createSettingsStore<BadgeSettings>('badge-settings.json', {
  enabled: true,
  pluginBadges: true,
  projectRailBadges: true,
}, undefined, { audit: { key: 'badge' } });

export const getSettings = store.get;
export const saveSettings = store.save;
