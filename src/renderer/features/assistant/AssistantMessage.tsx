import { useMemo } from 'react';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import type { AssistantMessage as AssistantMessageType } from './types';

interface Props {
  message: AssistantMessageType;
}

/**
 * Renders a single chat message.
 * User messages: right-aligned with accent background.
 * Assistant messages: left-aligned with rich markdown rendering
 * including code blocks, tables, lists, and inline images/SVGs.
 */
export function AssistantMessage({ message }: Props) {
  const isUser = message.role === 'user';

  const renderedHtml = useMemo(
    () => (isUser ? null : renderMarkdownSafe(message.content)),
    [isUser, message.content],
  );

  if (isUser) {
    return (
      <div className="flex justify-end" data-testid="user-message">
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-ctp-accent/10 text-sm text-ctp-text whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start gap-2" data-testid="assistant-message">
      {/* Mascot avatar */}
      <div className="w-6 h-6 rounded-full bg-ctp-accent/10 flex items-center justify-center flex-shrink-0 mt-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-accent">
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <line x1="12" y1="7" x2="12" y2="11" />
          <line x1="8" y1="16" x2="8" y2="16.01" />
          <line x1="16" y1="16" x2="16" y2="16.01" />
        </svg>
      </div>
      <div
        className="max-w-[85%] px-3 py-2 rounded-lg bg-ctp-mantle text-sm text-ctp-text leading-relaxed break-words assistant-markdown"
        dangerouslySetInnerHTML={{ __html: renderedHtml! }}
      />
    </div>
  );
}
