import { useRef, useEffect, useCallback } from 'react';
import { AssistantMessage } from './AssistantMessage';
import { AssistantActionCard } from './AssistantActionCard';
import type { FeedItem } from './types';

const SUGGESTED_PROMPTS = [
  'Find my projects and add them to Clubhouse',
  'Create a multi-agent canvas for debugging',
  'Help me write agent instructions',
  'What orchestrators are available?',
];

interface Props {
  items: FeedItem[];
  onSendPrompt: (prompt: string) => void;
}

/**
 * Scrollable message feed with auto-scroll behavior.
 * Shows welcome state with suggested prompts when empty.
 */
export function AssistantFeed({ items, onSendPrompt }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 60;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Auto-scroll to bottom when new items arrive (if user hasn't scrolled up)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !isNearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center" data-testid="assistant-feed-empty">
        <div className="max-w-sm px-4 text-center">
          {/* Robot icon */}
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-ctp-accent/10 flex items-center justify-center">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
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
          <p className="text-sm text-ctp-text mb-1 font-medium">
            Hi! I&apos;m the Clubhouse Assistant.
          </p>
          <p className="text-xs text-ctp-subtext0 mb-4">
            I can set up projects, create and configure agents, build canvases
            with wired-up workflows, write agent instructions, and more.
          </p>
          <div className="flex flex-wrap gap-2 justify-center" data-testid="suggested-prompts">
            {SUGGESTED_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                onClick={() => onSendPrompt(prompt)}
                className="px-3 py-1.5 text-xs rounded-full border border-surface-0 text-ctp-subtext0 hover:text-ctp-text hover:border-ctp-accent/40 hover:bg-surface-0 transition-colors cursor-pointer"
                data-testid="suggested-prompt"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3"
      onScroll={handleScroll}
      data-testid="assistant-feed"
    >
      {items.map((item) => {
        if (item.type === 'message' && item.message) {
          return <AssistantMessage key={item.message.id} message={item.message} />;
        }
        if (item.type === 'action' && item.action) {
          return <AssistantActionCard key={item.action.id} action={item.action} />;
        }
        return null;
      })}
    </div>
  );
}
