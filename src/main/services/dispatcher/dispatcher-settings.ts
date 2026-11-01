import { createSettingsStore } from '../settings-store';
import * as experimentalSettings from '../experimental-settings';

/** The experimental flag in Settings > Experimental (#2533). */
export const DISPATCHER_FLAG = 'dispatcher';

export interface DispatcherSettings {
  /** The "Turn on Dispatcher" switch on Settings > Dispatcher. */
  enabled: boolean;
}

const store = createSettingsStore<DispatcherSettings>('dispatcher-settings.json', { enabled: false });

export const getSettings = store.get;
export const updateSettings = store.update;

export function isDispatcherFlagOn(): boolean {
  return experimentalSettings.getSettings()[DISPATCHER_FLAG] === true;
}

/**
 * The flag is on AND the user turned the Dispatcher on. Everything that
 * shows or wires the Dispatcher gates on this.
 */
export function isDispatcherEnabled(): boolean {
  return isDispatcherFlagOn() && store.get().enabled === true;
}
