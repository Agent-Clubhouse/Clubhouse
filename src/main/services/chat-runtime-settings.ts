/**
 * Chat runtime preferences: the experimental `chat` flag and the per-provider
 * Chat / CLI choice. With the flag off, every agent runs in the terminal.
 */

import { createSettingsStore } from './settings-store';
import * as experimentalSettings from './experimental-settings';
import { isPreviewEligible } from './preview-eligible';
import { COPILOT_SDK_FLAG, type AgentRuntimeMode, type ChatDriverId, type ChatRuntimeSettings } from '../../shared/chat';

/** Experimental flag id (Settings › Experimental › Chat). */
export const CHAT_EXPERIMENTAL_FLAG = 'chat';

/** Mode a provider gets when the flag is on and the user hasn't chosen. */
export const DEFAULT_CHAT_PROVIDER_MODE: AgentRuntimeMode = 'chat';

const store = createSettingsStore<ChatRuntimeSettings>('chat-runtime-settings.json', {});

export const getSettings = store.get;
export const saveSettings = store.save;

/**
 * Chat is experimental and beta-only: the flag counts only in builds where
 * the Experimental settings page is shown (dev, pre-release, preview channel),
 * so a flag saved on a beta doesn't switch a stable build into chat.
 */
export function isChatEnabled(): boolean {
  return isPreviewEligible() && experimentalSettings.getSettings()[CHAT_EXPERIMENTAL_FLAG] === true;
}

/** The Copilot SDK driver's own flag, with the same beta-only gate as Chat. */
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
