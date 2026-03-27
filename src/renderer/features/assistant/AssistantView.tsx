import { useState, useCallback } from 'react';
import { AssistantHeader } from './AssistantHeader';
import { AssistantFeed } from './AssistantFeed';
import { AssistantInput } from './AssistantInput';
import type { FeedItem } from './types';

let nextId = 1;
function generateId(): string {
  return `msg-${nextId++}`;
}

/**
 * Top-level container for the Clubhouse Assistant.
 * Manages conversation state (Phase 1: local only, no agent backend).
 */
export function AssistantView() {
  const [feedItems, setFeedItems] = useState<FeedItem[]>([]);

  const handleSend = useCallback((content: string) => {
    const userItem: FeedItem = {
      type: 'message',
      message: {
        id: generateId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      },
    };
    setFeedItems((prev) => [...prev, userItem]);
  }, []);

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="assistant-view">
      <AssistantHeader />
      <AssistantFeed items={feedItems} onSendPrompt={handleSend} />
      <AssistantInput onSend={handleSend} />
    </div>
  );
}
