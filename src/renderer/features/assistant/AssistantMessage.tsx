import { useMemo } from 'react';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import type { AssistantMessage as AssistantMessageType } from './types';

interface Props {
  message: AssistantMessageType;
}

/**
 * Renders a single chat message.
 * User messages: right-aligned with subtle background.
 * Assistant messages: left-aligned with markdown rendering.
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
        <div className="max-w-[85%] px-3 py-2 rounded-lg bg-surface-1 text-sm text-ctp-text whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start" data-testid="assistant-message">
      <div
        className="max-w-[85%] px-3 py-2 text-sm text-ctp-text leading-relaxed whitespace-pre-wrap break-words prose-inline"
        dangerouslySetInnerHTML={{ __html: renderedHtml! }}
      />
    </div>
  );
}
