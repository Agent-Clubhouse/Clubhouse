import { useRef, useEffect, useCallback } from 'react';
import { AssistantMessage } from './AssistantMessage';
import { AssistantActionCard } from './AssistantActionCard';
import type { FeedItem } from './types';
import type { AssistantStatus } from './assistant-agent';

const SUGGESTED_PROMPTS = [
  { label: 'Set up a project', prompt: 'Help me set up a new project in Clubhouse' },
  { label: 'Configure agents', prompt: 'Help me configure agents for my project' },
  { label: 'Build a canvas', prompt: 'Create a multi-agent canvas for debugging' },
  { label: 'Learn the basics', prompt: 'What is Clubhouse and what can it do?' },
  { label: 'Write agent instructions', prompt: 'Help me write agent instructions' },
  { label: 'What orchestrators are available?', prompt: 'What orchestrators are available?' },
];

interface Props {
  items: FeedItem[];
  status: AssistantStatus;
  onSendPrompt: (prompt: string) => void;
}

/**
 * Scrollable message feed with auto-scroll behavior.
 * Shows welcome state with suggestion chips when empty.
 * Centered content with max-width for readability.
 */
export function AssistantFeed({ items, status, onSendPrompt }: Props) {
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
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto flex items-center justify-center px-4" data-testid="assistant-feed-empty">
        <div className="max-w-md text-center">
          {/* Mascot placeholder */}
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
            Hi! I&apos;m the Clubhouse Assistant.
          </p>
          <p className="text-sm text-ctp-subtext0 mb-6 leading-relaxed">
            I can set up projects, configure agents, build canvases,
            write agent instructions, and more.
          </p>
          <div className="flex flex-wrap gap-2 justify-center" data-testid="suggested-prompts">
            {SUGGESTED_PROMPTS.map(({ label, prompt }) => (
              <button
                key={label}
                onClick={() => onSendPrompt(prompt)}
                className="px-3 py-2 text-xs rounded-lg border border-surface-0 text-ctp-subtext0 hover:text-ctp-text hover:border-ctp-accent/40 hover:bg-ctp-accent/5 transition-colors cursor-pointer"
                data-testid="suggested-prompt"
              >
                {label}
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
      className="flex-1 min-h-0 overflow-y-auto px-4 py-4"
      onScroll={handleScroll}
      data-testid="assistant-feed"
    >
      <div className="max-w-[600px] mx-auto space-y-3">
        {items.map((item) => {
          if (item.type === 'message' && item.message) {
            return <AssistantMessage key={item.message.id} message={item.message} />;
          }
          if (item.type === 'action' && item.action) {
            return <AssistantActionCard key={item.action.id} action={item.action} />;
          }
          return null;
        })}
        {/* Loading indicator when assistant is thinking */}
        {status === 'responding' && (
          <div className="flex justify-start" data-testid="assistant-typing">
            <div className="px-3 py-2 rounded-lg bg-ctp-mantle">
              <div className="flex gap-1 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
