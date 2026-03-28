import { useState, useCallback, useEffect } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import { AgentTerminal } from '../agents/AgentTerminal';
import * as assistantAgent from './assistant-agent';
import type { FeedItem } from './types';
import type { AssistantMode, AssistantStatus } from './assistant-agent';

/**
 * Top-level container for the Clubhouse Assistant.
 *
 * Tri-state rendering:
 * - interactive: AgentTerminal (raw PTY canvas, same as durable agents)
 * - headless:    Chat feed + input (conversational via headless --continue)
 * - structured:  Chat feed + input (experimental typed events)
 */
export function AssistantView() {
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

  const handleSend = useCallback((content: string) => { assistantAgent.sendMessage(content); }, []);
  const handleModeChange = useCallback((m: AssistantMode) => { assistantAgent.setMode(m); }, []);
  const handleOrchestratorChange = useCallback((id: string | null) => { assistantAgent.setOrchestrator(id); }, []);

  const isDisabled = status === 'starting' || status === 'responding';

  // Interactive mode with active agent: show raw terminal canvas
  const showTerminal = mode === 'interactive' && agentId && (status === 'active' || status === 'responding');

  return (
    <div className="h-full min-h-0 flex flex-col bg-ctp-base" data-testid="assistant-view">
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
          <AssistantFeed items={feedItems} status={status} onSendPrompt={handleSend} />
          <AssistantInput onSend={handleSend} disabled={isDisabled} status={status} />
        </>
      )}
    </div>
  );
}
