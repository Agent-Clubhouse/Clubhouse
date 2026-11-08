import { COPILOT_ACP_REMOVED_NOTICE_KEY } from '../../shared/types';
import { useToastStore } from '../stores/toastStore';

export const COPILOT_ACP_REMOVED_MESSAGE =
  'Legacy Copilot ACP was removed, so Copilot chat now uses the Copilot SDK. If Copilot chat does not start, the agent opens in the CLI view.';

/**
 * Show a one-time notice to users who had the removed legacy Copilot ACP
 * opt-in on (#2868). The main-process migration sets the marker; this clears
 * it once shown.
 */
export async function showCopilotAcpRemovedNotice(): Promise<void> {
  const settings = await window.clubhouse.app.getExperimentalSettings();
  if (!settings[COPILOT_ACP_REMOVED_NOTICE_KEY]) return;
  useToastStore.getState().addToast(COPILOT_ACP_REMOVED_MESSAGE, 'info');
  const { [COPILOT_ACP_REMOVED_NOTICE_KEY]: _shown, ...rest } = settings;
  await window.clubhouse.app.saveExperimentalSettings(rest);
}
