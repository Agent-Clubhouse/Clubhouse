import { createSettingsStore } from '../settings-store';
import * as experimentalSettings from '../experimental-settings';
import { newChromeEnabled } from '../../window-chrome';
import { resolveDispatcherEnablement, type DispatcherEnablement } from '../../../shared/dispatcher-types';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';
import type { DispatcherBehavior } from '../../../shared/dispatcher-behavior';
import type { DispatcherModelsBefore, SavedDispatcherModels } from '../../../shared/dispatcher-models';
import type { DispatcherPersonality } from '../../../shared/dispatcher-personality';
import type { DispatcherSetupState } from '../../../shared/dispatcher-setup';

/** A saved experimental flag from before the Dispatcher graduated. Read, never written or offered. */
export const DISPATCHER_FLAG = 'dispatcher';

export interface DispatcherSettings {
  /** The "Turn on Dispatcher" switch on Settings > Dispatcher. Missing means the default. */
  enabled?: boolean;
  /** Behavior (#3045): Light, Standard or Thorough. Missing or unknown reads as Standard. */
  behavior?: DispatcherBehavior;
  /**
   * Choose models yourself (#3191): the switch and each job's pick. Missing
   * or off means Behavior gives the models. The picks stay when it goes off.
   */
  models?: SavedDispatcherModels;
  /** The provider and context its agents ran on when Choose models yourself went on, put back when it goes off. */
  modelsBefore?: DispatcherModelsBefore;
  /** Personality (#3047): the text for its chat's instructions and its preset. Missing reads as Concise. */
  personality?: DispatcherPersonality;
  /**
   * First-run setup (#3047). Missing until the Dispatcher is first turned on
   * in a version that has setup, which saves `pending` and whether it is an upgrade.
   */
  setup?: DispatcherSetupState;
}

const store = createSettingsStore<DispatcherSettings>('dispatcher-settings.json', {}, undefined, { audit: { key: 'dispatcher' } });

export const getSettings = store.get;
export const updateSettings = store.update;

/** Whether the Dispatcher is on, what its saved values say, and why it is off. */
export function dispatcherEnablement(): DispatcherEnablement {
  const saved: unknown = store.get().enabled;
  return resolveDispatcherEnablement({
    saved: typeof saved === 'boolean' ? saved : undefined,
    graduatedFlagOn: isGraduatedFlagOn(experimentalSettings.getSettings(), DISPATCHER_FLAG),
    newLayout: newChromeEnabled(),
  });
}

/** Everything that shows or wires the Dispatcher gates on this. */
export function isDispatcherEnabled(): boolean {
  return dispatcherEnablement().enabled;
}
