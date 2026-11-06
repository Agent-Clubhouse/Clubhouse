/**
 * One-time tip for people whose agents now open in Chat because it became the
 * default: a toast that links to Settings > Agents & providers, where they can
 * choose the CLI view.
 *
 * Two markers in localStorage (per user profile), each one-time:
 *
 * - `chatMessageShown`: the user has been told about chat. The toast sets it
 *   when it shows, and anything else that tells them, like a welcome intro's
 *   chat step (#2814), calls markChatMessageShown so the toast never shows.
 * - `clubhouse_chat_default_tip`: this user doesn't need telling. Set when a
 *   launch rules the toast out, and by the tip earlier builds showed. A new
 *   install has no agents, so it's ruled out on its first launch and doesn't
 *   show after it gets some.
 *
 * It only shows when chat comes from the default for an agent that already
 * exists: never with the flag saved either way, any saved provider or agent
 * choice, or no agent that would open in chat. The Dispatcher is in no project,
 * so it never counts. If the marker can't be written, it doesn't show at all: a
 * tip that can't be remembered would come back on every launch. A launch that
 * can't read the settings or a project's agents decides nothing, so the next one
 * asks again. That includes an unreadable flags file: the renderer's `chat: false`
 * is a stand-in then, not a choice.
 */

import { useToastStore } from '../../../stores/toastStore';
import { useUIStore } from '../../../stores/uiStore';

export const CHAT_MESSAGE_SHOWN_KEY = 'chatMessageShown';
export const CHAT_TIP_RULED_OUT_KEY = 'clubhouse_chat_default_tip';

type ChatTipRuledOut = 'saved_choice' | 'no_chat_agents';

export const CHAT_DEFAULT_TIP_TEXT = 'Agents now open in Chat. You can choose the CLI view in Settings > Agents & providers.';
export const CHAT_DEFAULT_TIP_ACTION = 'Open settings';

const DEFAULT_PROVIDER = 'claude-code';

function isMarked(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch { // telemetry-exempt: no storage means never nag
    return true;
  }
}

function mark(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch { // telemetry-exempt: storage unavailable; callers treat a failed write as "don't show"
    return false;
  }
}

/** Record that the user has been told about chat, so the toast doesn't show. False when storage refused the write. */
export function markChatMessageShown(): boolean {
  return mark(CHAT_MESSAGE_SHOWN_KEY, 'true');
}

/** The first saved agent that main says will wake in chat, or why the tip isn't needed. */
async function findDefaultChatAgent(): Promise<{ provider: string } | ChatTipRuledOut> {
  const flags = await window.clubhouse.app.getExperimentalSettings();
  if (typeof flags?.chat === 'boolean') return 'saved_choice';
  const settings = await window.clubhouse.chat.getRuntimeSettings();
  if (Object.values(settings ?? {}).some((s) => s?.mode)) return 'saved_choice';

  type Saved = { id?: string; orchestrator?: string; runtimeMode?: string | null };
  const projects: Array<{ path: string }> = await window.clubhouse.project.list();
  const lists = await Promise.all(projects.map(async (p) => ({
    path: p.path,
    configs: await (window.clubhouse.agent.listDurable(p.path) as Promise<Saved[]>),
  })));
  if (lists.some(({ configs }) => configs.some((c) => c?.runtimeMode))) return 'saved_choice';

  for (const { path, configs } of lists) {
    for (const { id, orchestrator } of configs) {
      if (!id) continue;
      const { chat } = await window.clubhouse.chat.getAgentRuntime(id, orchestrator, { projectPath: path, starting: true });
      if (chat) return { provider: orchestrator ?? DEFAULT_PROVIDER };
    }
  }
  return 'no_chat_agents';
}

/**
 * Show the tip if this launch calls for it. Rejects, deciding nothing, when the
 * settings can't be read. Called from one place, initAppEventBridge, so a
 * welcome intro (#2814) can run first or gate it there.
 */
export async function showChatDefaultTip(): Promise<void> {
  if (isMarked(CHAT_MESSAGE_SHOWN_KEY) || isMarked(CHAT_TIP_RULED_OUT_KEY)) return;
  if (await window.clubhouse.app.isExperimentalSettingsUnreadable()) return;
  const found = await findDefaultChatAgent();
  if (await window.clubhouse.app.isChatTipReadUncertain()) return;
  // An intro or another invocation may have completed while the reads awaited.
  if (isMarked(CHAT_MESSAGE_SHOWN_KEY) || isMarked(CHAT_TIP_RULED_OUT_KEY)) return;
  if (typeof found === 'string') {
    mark(CHAT_TIP_RULED_OUT_KEY, found);
    return;
  }
  if (!markChatMessageShown()) return;
  useToastStore.getState().addToast(CHAT_DEFAULT_TIP_TEXT, 'info', {
    label: CHAT_DEFAULT_TIP_ACTION,
    onClick: () => useUIStore.getState().openRuntimeSettings(found.provider),
  });
}
