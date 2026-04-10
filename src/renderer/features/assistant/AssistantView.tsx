import { useState, useCallback, useEffect } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import { AgentTerminal } from '../agents/AgentTerminal';
import * as assistantAgent from './assistant-agent';
import { useUIStore } from '../../stores/uiStore';
import type { FeedItem } from './types';
import type { AssistantMode, AssistantStatus } from './assistant-agent';

/**
 * Top-level container for the Clubhouse Assistant.
 *
 * Self-gates on the `experimental.assistant` feature flag. When the flag is
 * disabled (or while it is loading), renders a friendly placeholder instead
 * of the chat UI — never an empty page. The previous gating in App.tsx
 * (Mission 61, PR #1347) wrapped this view in `{assistantEnabled && ...}`,
 * which produced a blank assistant page when the flag was off, when the IPC
 * fetch failed silently, or during the async race before it resolved. That
 * is the visual "crash on view" Mason reported in Mission 73.
 *
 * Tri-state rendering (when enabled):
 * - interactive: AgentTerminal (raw PTY canvas, same as durable agents)
 * - headless:    Chat feed + input (conversational via headless --continue)
 * - structured:  Chat feed + input (experimental typed events)
 */
export function AssistantView() {
  // Experimental flag gating (tri-state: null = loading, true = enabled, false = disabled).
  // Lives inside this component so the assistant page is never empty when navigated to.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.clubhouse.app.getExperimentalSettings()
      .then((flags) => {
        if (!cancelled) setEnabled(!!flags.assistant);
      })
      .catch((err) => {
        // Don't leave the user stranded on a blank page if the IPC fails.
        // Treat fetch failure as "disabled" so the placeholder explains the situation,
        // and surface the error to the renderer console for diagnosis.
        console.error('AssistantView: failed to load experimental settings', err);
        if (!cancelled) setEnabled(false);
      });
    return () => { cancelled = true; };
  }, []);

  const [feedItems, setFeedItems] = useState<FeedItem[]>(() => assistantAgent.getFeedItems());
  const [status, setStatus] = useState<AssistantStatus>(() => assistantAgent.getStatus());
  const [mode, setMode] = useState<AssistantMode>(() => assistantAgent.getMode());
  const [orchestrator, setOrchestrator] = useState<string | null>(() => assistantAgent.getOrchestrator());
  const [agentId, setAgentId] = useState<string | null>(() => assistantAgent.getAgentId());

  useEffect(() => {
    const u1 = assistantAgent.onFeedUpdate(setFeedItems);
    const u2 = assistantAgent.onStatusChange((s) => setStatus(s));
    const u3 = assistantAgent.onModeChange(setMode);
    const u4 = assistantAgent.onOrchestratorChange(setOrchestrator);
    const u5 = assistantAgent.onAgentIdChange(setAgentId);
    return () => { u1(); u2(); u3(); u4(); u5(); };
  }, []);

  // Restore persisted chat history once the flag resolves to enabled.
  // loadHistory was previously dead code — exported but never called from
  // production, which meant users always lost their chat history on view open.
  useEffect(() => {
    if (enabled === true) {
      assistantAgent.loadHistory().catch((err) => {
        console.error('AssistantView: failed to load chat history', err);
      });
    }
  }, [enabled]);

  const handleSend = useCallback((content: string) => { assistantAgent.sendMessage(content); }, []);
  const handleModeChange = useCallback((m: AssistantMode) => { assistantAgent.setMode(m); }, []);
  const handleOrchestratorChange = useCallback((id: string | null) => { assistantAgent.setOrchestrator(id); }, []);
  const handleApproveAction = useCallback((actionId: string) => { assistantAgent.approveAction(actionId); }, []);
  const handleSkipAction = useCallback((actionId: string) => { assistantAgent.skipAction(actionId); }, []);

  const setExplorerTab = useUIStore((s) => s.setExplorerTab);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);
  const handleOpenSettings = useCallback(() => {
    setExplorerTab('settings');
    setSettingsSubPage('experimental');
  }, [setExplorerTab, setSettingsSubPage]);

  // Loading state — flag fetch is in flight. Render a minimal container so the
  // page is never blank during the (usually millisecond-scale) IPC round-trip.
  if (enabled === null) {
    return (
      <div
        className="h-full min-h-0 flex items-center justify-center bg-ctp-base"
        data-testid="assistant-view"
        data-assistant-state="loading"
      >
        <span className="text-xs text-ctp-subtext0">{'Loading\u2026'}</span>
      </div>
    );
  }

  // Disabled state — flag is off (or fetch failed). Friendly placeholder
  // explains the situation and provides a recovery path to the settings page.
  // This is the fix for Mission 73's "visual crash" — previously this same
  // situation produced an empty page with only the title bar and banners.
  if (enabled === false) {
    return (
      <div
        className="h-full min-h-0 flex items-center justify-center px-6 bg-ctp-base"
        data-testid="assistant-view"
        data-assistant-state="disabled"
      >
        <div className="max-w-md text-center">
          <div className="flex justify-center mb-5">
            <div className="w-20 h-20 rounded-full bg-ctp-accent/10 flex items-center justify-center">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-ctp-accent"
              >
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="2" />
                <line x1="12" y1="7" x2="12" y2="11" />
                <line x1="8" y1="16" x2="8" y2="16.01" />
                <line x1="16" y1="16" x2="16" y2="16.01" />
              </svg>
            </div>
          </div>
          <p className="text-base text-ctp-text mb-1 font-semibold">
            The Assistant is an experimental feature
          </p>
          <p className="text-sm text-ctp-subtext0 mb-6 leading-relaxed">
            Enable it in <span className="text-ctp-text">Settings &rarr; Experimental</span> to
            chat with the built-in helper, scaffold projects, and configure agents.
          </p>
          <button
            onClick={handleOpenSettings}
            className="px-4 py-2 text-sm rounded-lg bg-ctp-accent text-white font-medium hover:opacity-90 cursor-pointer"
            data-testid="assistant-open-settings-button"
          >
            Open Experimental Settings
          </button>
        </div>
      </div>
    );
  }

  const isDisabled = status === 'starting' || status === 'responding';

  // Interactive mode with active agent: show raw terminal canvas
  const showTerminal = mode === 'interactive' && agentId && (status === 'active' || status === 'responding');

  return (
    <div className="h-full min-h-0 flex flex-col bg-ctp-base" data-testid="assistant-view" data-assistant-state="enabled">
      <AssistantHeader
        onReset={assistantAgent.reset}
        mode={mode}
        onModeChange={handleModeChange}
        orchestrator={orchestrator}
        onOrchestratorChange={handleOrchestratorChange}
        status={status}
      />
      {showTerminal ? (
        <div className="flex-1 min-h-0">
          <AgentTerminal agentId={agentId} focused />
        </div>
      ) : (
        <>
          <AssistantFeed
            items={feedItems}
            status={status}
            onSendPrompt={handleSend}
            onApproveAction={handleApproveAction}
            onSkipAction={handleSkipAction}
          />
          <AssistantInput onSend={handleSend} disabled={isDisabled} status={status} />
        </>
      )}
    </div>
  );
}
