import { useEffect, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { CHAT_DEFAULT_TIP_TEXT, resolveChatTip, shouldShowChatDefaultTip } from './chat-default-tip';

/** Only one pane gets the tip, even when several chat agents mount together. */
let claimed = false;

/** For tests. */
export function resetChatDefaultTipClaim(): void {
  claimed = false;
}

/**
 * The first-launch "Agents now open in Chat" tip, anchored under the Chat /
 * Terminal switch. It never blocks the agent: no overlay, no focus steal.
 */
export function ChatDefaultTip({ agent }: { agent: Agent }) {
  const [visible, setVisible] = useState(false);
  const projects = useProjectStore((s) => s.projects);
  const provider = agent.orchestrator ?? 'claude-code';

  useEffect(() => {
    if (claimed) return;
    let cancelled = false;
    void shouldShowChatDefaultTip(agent, projects)
      .then((show) => {
        if (cancelled || !show || claimed) return;
        claimed = true;
        // Remembered as soon as it's seen, so it shows once even if ignored.
        // Storage that can't remember it means no tip, not a tip every launch.
        if (!resolveChatTip('shown')) return;
        setVisible(true);
      })
      .catch(() => {
        // telemetry-exempt: an optional tip; failing to decide just means no tip.
      });
    return () => { cancelled = true; };
    // Decided once per agent pane; later setting changes go through resolveChatTip.
  }, [agent.id, projects.length]);

  // Escape dismisses it, like Got it. It never takes focus, so other Escape
  // handlers (dialogs) keep working; an already-handled Escape is left alone.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      resolveChatTip('dismissed');
      setVisible(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible]);

  if (!visible) return null;
  return (
    <div
      role="status"
      aria-label="Chat is the default"
      data-testid="chat-default-tip"
      className="absolute right-0 top-full mt-2 z-20 w-[290px] rounded-md border border-surface-1 bg-ctp-mantle p-3 text-[12px] leading-snug text-ctp-subtext1 shadow-lg"
    >
      <p>{CHAT_DEFAULT_TIP_TEXT}</p>
      <div className="mt-2.5 flex justify-end gap-2">
        <button
          type="button"
          className="px-2 py-1 rounded text-ctp-subtext1 hover:text-ctp-text hover:bg-surface-0"
          onClick={() => {
            resolveChatTip('opened_settings');
            setVisible(false);
            useUIStore.getState().openRuntimeSettings(provider);
          }}
        >
          Open settings
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded bg-surface-0 text-ctp-text hover:bg-surface-1"
          onClick={() => { resolveChatTip('dismissed'); setVisible(false); }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}
