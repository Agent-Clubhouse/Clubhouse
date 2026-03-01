import { useState } from 'react';

interface Props {
  text: string;
  isStreaming: boolean;
}

/**
 * Renders thinking/reasoning events as a collapsible dimmed panel.
 * Collapsed by default; user can expand to see agent reasoning.
 */
export function ThinkingPanel({ text, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (!text) return null;

  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle/50" data-testid="thinking-panel">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <svg className="w-3.5 h-3.5 text-ctp-subtext0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6" />
          <circle cx="8" cy="8" r="1" fill="currentColor" />
          <line x1="8" y1="2" x2="8" y2="4" />
          <line x1="8" y1="12" x2="8" y2="14" />
          <line x1="2" y1="8" x2="4" y2="8" />
          <line x1="12" y1="8" x2="14" y2="8" />
        </svg>
        <span className="text-xs text-ctp-subtext0 italic">
          {isStreaming ? 'Thinking...' : 'Thought'}
        </span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-ctp-subtext0 animate-pulse" />
        )}
        <svg
          className={`w-3 h-3 text-ctp-subtext0 ml-auto transition-transform ${expanded ? 'rotate-90' : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 4 10 8 6 12" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t border-surface-0 px-3 py-2">
          <p className="text-xs text-ctp-subtext0 italic leading-relaxed whitespace-pre-wrap break-words">
            {text}
          </p>
        </div>
      )}
    </div>
  );
}
