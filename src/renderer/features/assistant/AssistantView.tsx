import { useState, useCallback, useEffect } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import * as assistantAgent from './assistant-agent';
import type { FeedItem } from './types';
import type { AssistantMode } from './assistant-agent';

/**
 * Top-level container for the Clubhouse Assistant.
 * Supports interactive, structured, and headless execution modes.
 */
export function AssistantView() {
  const [feedItems, setFeedItems] = useState<FeedItem[]>(() => assistantAgent.getFeedItems());
  const [status, setStatus] = useState(() => assistantAgent.getStatus());
  const [mode, setMode] = useState<AssistantMode>(() => assistantAgent.getMode());

  useEffect(() => {
    const unsubFeed = assistantAgent.onFeedUpdate(setFeedItems);
    const unsubStatus = assistantAgent.onStatusChange((s) => setStatus(s));
    const unsubMode = assistantAgent.onModeChange(setMode);
    return () => { unsubFeed(); unsubStatus(); unsubMode(); };
  }, []);

  const handleSend = useCallback((content: string) => {
    assistantAgent.sendMessage(content);
  }, []);

  const handleModeChange = useCallback((m: AssistantMode) => {
    assistantAgent.setMode(m);
  }, []);

  const isDisabled = status === 'starting' || status === 'responding';

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="assistant-view">
      <AssistantHeader onReset={assistantAgent.reset} mode={mode} onModeChange={handleModeChange} />
      <AssistantFeed items={feedItems} onSendPrompt={handleSend} />
      <AssistantInput onSend={handleSend} disabled={isDisabled} />
    </div>
  );
}
