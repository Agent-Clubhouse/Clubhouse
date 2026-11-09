/**
 * Choose models yourself (#3191) on the main side: the saved switch and picks.
 * What they mean is in shared/dispatcher-models.ts; dispatcher-service gives
 * the picks to its two agents and keeps Behavior from overwriting them.
 */

import { normalizeDispatcherModels, type DispatcherModelsState } from '../../../shared/dispatcher-models';
import { getSettings, updateSettings } from './dispatcher-settings';

/** The switch and the picks as saved. Off until a person turns it on. */
export function getDispatcherModels(): DispatcherModelsState {
  return normalizeDispatcherModels(getSettings().models);
}

/** Whether the user chooses the models, so Behavior must leave them alone. */
export function modelsChosenByHand(): boolean {
  return getDispatcherModels().byHand;
}

/** Save the switch and the picks. Returns whether anything changed. */
export async function saveDispatcherModels(next: DispatcherModelsState): Promise<boolean> {
  const current = getDispatcherModels();
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  await updateSettings((settings) => ({
    ...settings,
    models: {
      byHand: next.byHand,
      ...(next.chat && { chat: next.chat }),
      ...(next.work && { work: next.work }),
    },
  }));
  return true;
}
