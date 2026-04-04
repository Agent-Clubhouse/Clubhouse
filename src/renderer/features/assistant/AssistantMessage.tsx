import { useMemo, useRef, useState, useEffect } from 'react';
import { renderMarkdownSafe } from '../../utils/safe-markdown';
import type { AssistantMessage as AssistantMessageType } from './types';

interface Props {
  message: AssistantMessageType;
  /** When true, the message is actively streaming and markdown parsing is throttled. */
  streaming?: boolean;
}

/** Throttle interval for markdown parsing during active streaming (ms). */
const STREAM_PARSE_INTERVAL = 150;

/**
 * Renders a single chat message.
 * User messages: right-aligned with accent background.
 * Assistant messages: left-aligned with rich markdown rendering
 * including code blocks, tables, lists, and inline images/SVGs.
 *
 * During active streaming, markdown parsing is throttled to avoid
 * re-parsing on every chunk (can be 50+/sec). Parses immediately
 * when streaming completes.
 */
export function AssistantMessage({ message, streaming }: Props) {
  const isUser = message.role === 'user';

  // Eager parse for non-streaming or user messages
  const eagerHtml = useMemo(
    () => (!streaming && !isUser ? renderMarkdownSafe(message.content) : null),
    [isUser, streaming, message.content],
  );

  // Throttled parse for streaming messages
  const [throttledHtml, setThrottledHtml] = useState<string | null>(null);
  const lastParseTime = useRef(0);
  const throttleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!streaming || isUser) return;
    const now = Date.now();
    const elapsed = now - lastParseTime.current;
    if (elapsed >= STREAM_PARSE_INTERVAL) {
      lastParseTime.current = now;
      setThrottledHtml(renderMarkdownSafe(message.content));
    } else if (!throttleTimer.current) {
      throttleTimer.current = setTimeout(() => {
        throttleTimer.current = null;
        lastParseTime.current = Date.now();
        setThrottledHtml(renderMarkdownSafe(message.content));
      }, STREAM_PARSE_INTERVAL - elapsed);
    }
    return () => {
      if (throttleTimer.current) {
        clearTimeout(throttleTimer.current);
        throttleTimer.current = null;
      }
    };
  }, [streaming, isUser, message.content]);

  const renderedHtml = streaming ? throttledHtml : eagerHtml;

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
