import { useState, useCallback, useEffect } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import * as assistantAgent from './assistant-agent';
import type { FeedItem } from './types';
import type { AssistantMode } from './assistant-agent';

export function AssistantView() {
  const [feedItems, setFeedItems] = useState<FeedItem[]>(() => assistantAgent.getFeedItems());
  const [status, setStatus] = useState(() => assistantAgent.getStatus());
  const [mode, setMode] = useState<AssistantMode>(() => assistantAgent.getMode());
  const [orchestrator, setOrchestrator] = useState<string | null>(() => assistantAgent.getOrchestrator());

  useEffect(() => {
    const u1 = assistantAgent.onFeedUpdate(setFeedItems);
    const u2 = assistantAgent.onStatusChange((s) => setStatus(s));
    const u3 = assistantAgent.onModeChange(setMode);
    const u4 = assistantAgent.onOrchestratorChange(setOrchestrator);
    return () => { u1(); u2(); u3(); u4(); };
  }, []);

  const handleSend = useCallback((content: string) => { assistantAgent.sendMessage(content); }, []);
  const handleModeChange = useCallback((m: AssistantMode) => { assistantAgent.setMode(m); }, []);
  const handleOrchestratorChange = useCallback((id: string | null) => { assistantAgent.setOrchestrator(id); }, []);

  const isDisabled = status === 'starting' || status === 'responding';

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="assistant-view">
      <AssistantHeader
        onReset={assistantAgent.reset}
        mode={mode}
        onModeChange={handleModeChange}
        orchestrator={orchestrator}
        onOrchestratorChange={handleOrchestratorChange}
      />
      <AssistantFeed items={feedItems} onSendPrompt={handleSend} />
      <AssistantInput onSend={handleSend} disabled={isDisabled} />
    </div>
  );
}
