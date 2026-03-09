import { useMemo } from 'react';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';

interface Props {
  text: string;
  isStreaming: boolean;
}

/**
 * Renders streaming text from text_delta / text_done events with basic markdown.
 * Accumulates deltas in the parent; this component just renders the buffer.
 */
export function MessageStream({ text, isStreaming }: Props) {
  const rendered = useMemo(() => renderMarkdownSafe(text), [text]);

  if (!text) return null;

  return (
    <div className="px-4 py-2" data-testid="message-stream">
      <div
        className="text-sm text-ctp-text leading-relaxed whitespace-pre-wrap break-words prose-inline"
        dangerouslySetInnerHTML={{ __html: rendered }}
      />
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-ctp-accent animate-pulse ml-0.5 align-text-bottom" />
      )}
    </div>
  );
}
