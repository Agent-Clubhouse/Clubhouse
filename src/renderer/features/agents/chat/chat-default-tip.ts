/**
 * First-launch tip for Chat as the default runtime
 * (docs/structured-chat-research.md §8.0 step 4): "Agents now open in Chat…"
 * next to the Chat / Terminal switch, once per user.
 *
 * It only shows when chat came from the default: never once the user has
 * explicitly chosen Terminal anywhere (a provider setting, or the switch),
 * and not for a provider or agent explicitly set to Chat. The decision is
 * remembered in localStorage (per user profile) as soon as the tip is shown,
 * so it never reappears, even if neither button is pressed.
 */

import type { Agent } from '../../../../shared/types';

export const CHAT_DEFAULT_TIP_KEY = 'clubhouse_chat_default_tip';

export type ChatTipResolution = 'shown' | 'dismissed' | 'opened_settings' | 'chose_terminal' | 'chose_chat';

export const CHAT_DEFAULT_TIP_TEXT = 'Agents now open in Chat. Prefer the terminal? You can change it for each provider in Settings.';

/** True once the tip has been shown or ruled out. Storage errors count as resolved: never nag. */
export function isChatTipResolved(): boolean {
  try {
    return localStorage.getItem(CHAT_DEFAULT_TIP_KEY) !== null;
  } catch { // telemetry-exempt: no storage means never nag
    return true;
  }
}

/** Record why the tip is done; any stored value means it never shows again. */
export function resolveChatTip(how: ChatTipResolution): void {
  try {
    localStorage.setItem(CHAT_DEFAULT_TIP_KEY, how);
  } catch { // telemetry-exempt: storage unavailable; the tip just may show again
  }
}

/** Record an explicit Terminal choice: the user never needs the tip after that. */
export function noteExplicitTerminalChoice(): void {
  resolveChatTip('chose_terminal');
}

/**
 * Whether to show the tip for this chat agent. Checks the saved choices
 * (provider settings, then the agent's own override) and resolves the tip
 * when they rule it out for good.
 */
export async function shouldShowChatDefaultTip(agent: Agent, projectPath: string | undefined): Promise<boolean> {
  if (isChatTipResolved()) return false;
  const provider = agent.orchestrator ?? 'claude-code';
  const settings = await window.clubhouse.chat.getRuntimeSettings();
  if (Object.values(settings ?? {}).some((s) => s?.mode === 'terminal')) {
    noteExplicitTerminalChoice();
    return false;
  }
  if (settings?.[provider]?.mode === 'chat') {
    resolveChatTip('chose_chat');
    return false;
  }
  if (projectPath) {
    const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
    if (config?.runtimeMode === 'terminal') {
      noteExplicitTerminalChoice();
      return false;
    }
    if (config?.runtimeMode === 'chat') return false;
  }
  return true;
}
