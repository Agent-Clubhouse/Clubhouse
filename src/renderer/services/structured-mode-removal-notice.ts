import { STRUCTURED_MODE_REMOVED_NOTICE_KEY } from '../../shared/types';
import { useToastStore } from '../stores/toastStore';

export const STRUCTURED_MODE_REMOVED_MESSAGE =
  'Structured mode was removed. Agents that used it now open in the CLI view.';

/**
 * Show a one-time notice to users who had the removed Structured Mode flag on.
 * The main-process migration sets the marker; this clears it once shown.
 */
export async function showStructuredModeRemovedNotice(): Promise<void> {
  const settings = await window.clubhouse.app.getExperimentalSettings();
  if (!settings[STRUCTURED_MODE_REMOVED_NOTICE_KEY]) return;
  useToastStore.getState().addToast(STRUCTURED_MODE_REMOVED_MESSAGE, 'info');
  const { [STRUCTURED_MODE_REMOVED_NOTICE_KEY]: _shown, ...rest } = settings;
  await window.clubhouse.app.saveExperimentalSettings(rest);
}
