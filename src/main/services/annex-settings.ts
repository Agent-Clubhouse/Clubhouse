import * as os from 'os';
import { createSettingsStore } from './settings-store';
import type { AnnexSettings } from '../../shared/types';

const store = createSettingsStore<AnnexSettings>('annex-settings.json', {
  enabled: false,
  deviceName: `Clubhouse on ${os.hostname()}`,
  alias: os.hostname(),
  icon: 'computer',
  color: 'indigo',
  autoReconnect: true,
});

export const getSettings = store.get;
export const saveSettings = store.save;
export const updateSettings = store.update;
