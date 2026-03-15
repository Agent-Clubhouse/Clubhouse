import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdownSafe } from '../../../utils/safe-markdown';

interface Props {
  text: string;
  isStreaming: boolean;
}

/** Debounce interval for markdown processing during streaming (ms). */
const STREAMING_DEBOUNCE_MS = 100;

/**
 * Renders streaming text from text_delta / text_done events with basic markdown.
 * Accumulates deltas in the parent; this component just renders the buffer.
 *
 * During streaming, markdown processing is debounced to avoid quadratic cost
 * from re-running the full regex pipeline on every token delta.
 */
export function MessageStream({ text, isStreaming }: Props) {
  const [debouncedText, setDebouncedText] = useState(text);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isStreaming) {
      // Streaming stopped — render final text immediately
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setDebouncedText(text);
      return;
    }

    // During streaming, debounce to limit markdown pipeline invocations
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(() => {
      setDebouncedText(text);
      timerRef.current = null;
    }, STREAMING_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [text, isStreaming]);

  const rendered = useMemo(() => renderMarkdownSafe(debouncedText), [debouncedText]);

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
