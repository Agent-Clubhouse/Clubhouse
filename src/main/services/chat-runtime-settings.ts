/**
 * Chat runtime preferences: the `chat` flag and the per-provider Chat / CLI
 * choice. With the flag saved off, every agent runs in the terminal.
 */

import { createSettingsStore, peekStoredSettingsSync } from './settings-store';
import * as experimentalSettings from './experimental-settings';
import { isPreviewEligible } from './preview-eligible';
import { COPILOT_SDK_FLAG, type AgentRuntimeMode, type ChatDriverId, type ChatRuntimeSettings } from '../../shared/chat';

/** The flag's id in experimental settings (Settings › Agents & providers › Chat view). */
export const CHAT_EXPERIMENTAL_FLAG = 'chat';

/** Mode a provider gets when the flag is on and the user hasn't chosen. */
export const DEFAULT_CHAT_PROVIDER_MODE: AgentRuntimeMode = 'chat';

const store = createSettingsStore<ChatRuntimeSettings>('chat-runtime-settings.json', {}, undefined, { audit: { key: 'chat_runtime' } });

let chatTipRuntimeReadUncertain = false;
export function isChatTipRuntimeReadUncertain(): boolean { return chatTipRuntimeReadUncertain; }
export function getSettings(): ChatRuntimeSettings {
  const disk = peekStoredSettingsSync('chat-runtime-settings.json');
  if (disk === 'unreadable' || (disk !== 'missing' && Object.values(disk).some((value) =>
    !value || typeof value !== 'object' || Array.isArray(value) ||
    ('mode' in value && value.mode !== 'chat' && value.mode !== 'terminal')
  ))) chatTipRuntimeReadUncertain = true;
  return store.get();
}
export const saveSettings = store.save;

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
  // With its flag off, a saved SDK choice is ignored but kept, so it applies again when the flag comes back.
  const driver = setting?.driver === 'copilot_sdk' && !isCopilotSdkEnabled() ? undefined : setting?.driver;
  return {
    mode: agentOverride ?? setting?.mode ?? DEFAULT_CHAT_PROVIDER_MODE,
    ...(driver ? { driver } : {}),
  };
}
