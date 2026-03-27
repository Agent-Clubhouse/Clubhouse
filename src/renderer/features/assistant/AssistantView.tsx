import { useState, useCallback, useEffect } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import * as assistantAgent from './assistant-agent';
import type { FeedItem } from './types';

/**
 * Top-level container for the Clubhouse Assistant.
 * Wired to the assistant agent backend for live conversations.
 */
export function AssistantView() {
  const [feedItems, setFeedItems] = useState<FeedItem[]>(() => assistantAgent.getFeedItems());
  const [status, setStatus] = useState(() => assistantAgent.getStatus());

  useEffect(() => {
    const unsubFeed = assistantAgent.onFeedUpdate(setFeedItems);
    const unsubStatus = assistantAgent.onStatusChange((s) => setStatus(s));
    return () => {
      unsubFeed();
      unsubStatus();
    };
  }, []);

  const handleSend = useCallback((content: string) => {
    assistantAgent.sendMessage(content);
  }, []);

  const isDisabled = status === 'starting' || status === 'responding';

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="assistant-view">
      <AssistantHeader onReset={assistantAgent.reset} />
      <AssistantFeed items={feedItems} onSendPrompt={handleSend} />
      <AssistantInput onSend={handleSend} disabled={isDisabled} />
    </div>
  );
}
