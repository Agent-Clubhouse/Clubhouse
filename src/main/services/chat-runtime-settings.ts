/**
 * Chat runtime preferences: the `chat` flag and the per-provider Chat / CLI
 * choice. With the flag saved off, every agent runs in the terminal.
 */

import { createSettingsStore } from './settings-store';
import * as experimentalSettings from './experimental-settings';
import { isPreviewEligible } from './preview-eligible';
import { COPILOT_SDK_FLAG, type AgentRuntimeMode, type ChatDriverId, type ChatRuntimeSettings } from '../../shared/chat';

/** The flag's id in experimental settings (Settings › Agents & providers › Chat view). */
export const CHAT_EXPERIMENTAL_FLAG = 'chat';

/** Mode a provider gets when the flag is on and the user hasn't chosen. */
export const DEFAULT_CHAT_PROVIDER_MODE: AgentRuntimeMode = 'chat';

let chatTipRuntimeReadUncertain = false;
function validRuntimeSettings(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((entry) =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry) &&
    (!('mode' in entry) || entry.mode === 'chat' || entry.mode === 'terminal')
  );
}
const store = createSettingsStore<ChatRuntimeSettings>('chat-runtime-settings.json', {}, undefined, {
  audit: { key: 'chat_runtime' },
  onLoad: (result) => {
    if ('error' in result) {
      chatTipRuntimeReadUncertain = (result.error as NodeJS.ErrnoException)?.code !== 'ENOENT';
      return;
    }
    try { chatTipRuntimeReadUncertain = !validRuntimeSettings(JSON.parse(result.raw)); }
    catch { chatTipRuntimeReadUncertain = true; } // telemetry-exempt: the toast defers
  },
});

export function isChatTipRuntimeReadUncertain(): boolean { return chatTipRuntimeReadUncertain; }
export const getSettings = store.get;
export async function saveSettings(settings: ChatRuntimeSettings): Promise<void> {
  await store.save(settings);
  chatTipRuntimeReadUncertain = !validRuntimeSettings(settings);
}

/** Chat is on in every build unless the flag is saved off, or the file that may say so can't be read. */
export function isChatEnabled(): boolean {
  return experimentalSettings.isGraduatedFeatureOn(CHAT_EXPERIMENTAL_FLAG);
}

/** The Copilot SDK driver's own flag: still experimental, so beta-only. */
export function isCopilotSdkEnabled(): boolean {
  return isPreviewEligible() && experimentalSettings.getSettings()[COPILOT_SDK_FLAG] === true;
}

export interface ResolvedRuntimeMode {
  mode: AgentRuntimeMode;
  driver?: ChatDriverId;
}

/** Effective mode for a provider, honouring a per-agent override. */
export function resolveRuntimeMode(provider: string, agentOverride?: AgentRuntimeMode): ResolvedRuntimeMode {
  if (!isChatEnabled()) return { mode: 'terminal' };
  const setting = getSettings()[provider];
  // The experimental flag is the sole Copilot choice. Legacy preferences are
  // retained for downgrade compatibility but cannot override either flag state.
  const driver = provider === 'copilot-cli'
    ? (isCopilotSdkEnabled() ? 'copilot_sdk' : 'copilot_acp')
    : setting?.driver;
  return {
    mode: agentOverride ?? setting?.mode ?? DEFAULT_CHAT_PROVIDER_MODE,
    ...(driver ? { driver } : {}),
  };
}
