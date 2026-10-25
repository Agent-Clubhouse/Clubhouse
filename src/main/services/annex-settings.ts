import * as os from 'os';
import { createSettingsStore } from './settings-store';
import type { AnnexSettings } from '../../shared/types';

const store = createSettingsStore<AnnexSettings>('annex-settings.json', {
  enableServer: false,
  enableClient: false,
  deviceName: `Clubhouse on ${os.hostname()}`,
  alias: os.hostname(),
  icon: 'computer',
  color: 'indigo',
  autoReconnect: true,
});

/** Migrate legacy `enabled` field to `enableServer` + `enableClient`. */
function migrateSettings(settings: AnnexSettings): AnnexSettings {
  if (settings.enabled !== undefined) {
    const migrated = { ...settings };
    // Legacy `enabled: true` → enable both server and client (preserves old behavior)
    // Always apply: the store defaults would have set these to false already
    migrated.enableServer = !!settings.enabled;
    migrated.enableClient = !!settings.enabled;
    delete migrated.enabled;
    return migrated;
  }
  return settings;
}

export function getSettings(): AnnexSettings {
  return migrateSettings(store.get());
}

export async function saveSettings(settings: AnnexSettings): Promise<void> {
  const migrated = migrateSettings(settings);
  // Strip legacy field on save
  const clean = { ...migrated };
  delete clean.enabled;
  return store.save(clean);
}

export const updateSettings = store.update;

/** Ports the Annex servers last bound, so a phone's remembered pairing survives a relaunch. */
export interface AnnexLastPorts {
  mainPort: number;
  pairingPort: number;
}

// Kept apart from AnnexSettings: the renderer saves that object whole, and
// would drop server-owned fields it never loaded.
const portsStore = createSettingsStore<AnnexLastPorts>('annex-ports.json', {
  mainPort: 0,
  pairingPort: 0,
});

export const getLastPorts = portsStore.get;
export const saveLastPorts = portsStore.save;
