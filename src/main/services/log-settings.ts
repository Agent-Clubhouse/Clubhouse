import { LoggingSettings } from '../../shared/types';
import { createSettingsStore } from './settings-store';

const store = createSettingsStore<LoggingSettings>('logging-settings.json', {
  enabled: true,
  namespaces: {},
  retention: 'medium',
  minLogLevel: 'info',
  telemetryRecording: true,
  telemetryLevel: 'standard',
});

export const getSettings = store.get;
export const saveSettings = store.save;
export const updateSettings = store.update;
