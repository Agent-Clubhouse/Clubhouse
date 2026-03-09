import { useEffect, useRef, useState } from 'react';

interface Props {
  text: string;
  isStreaming: boolean;
}

/**
 * Renders streaming text from text_delta / text_done events with basic markdown.
 * Accumulates deltas in the parent; this component just renders the buffer.
 *
 * During streaming, markdown rendering is debounced to avoid the O(N²) cost of
 * running the full regex pipeline on every incoming token.
 */
export function MessageStream({ text, isStreaming }: Props) {
  const [renderedHtml, setRenderedHtml] = useState(() => renderMarkdown(text));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (isStreaming) {
      // Debounce during streaming: only re-render markdown every 50 ms instead
      // of on every token, reducing total work from O(N²) to O(N).
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        setRenderedHtml(renderMarkdown(text));
      }, 50);
    } else {
      // Streaming finished — render immediately so the final result is sharp.
      setRenderedHtml(renderMarkdown(text));
    }

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [text, isStreaming]);

  if (!text) return null;

  return (
    <div className="px-4 py-2" data-testid="message-stream">
      <div
        className="text-sm text-ctp-text leading-relaxed whitespace-pre-wrap break-words prose-inline"
        dangerouslySetInnerHTML={{ __html: renderedHtml }}
      />
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-ctp-accent animate-pulse ml-0.5 align-text-bottom" />
      )}
    </div>
  );
}

/** Lightweight markdown: code blocks, inline code, bold, italic, links, lists. */
function renderMarkdown(text: string): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Fenced code blocks: ```lang\n...\n```
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre class="bg-ctp-mantle rounded p-2 my-1 text-xs overflow-x-auto"><code>${code.trim()}</code></pre>`
  );

  // Inline code: `...`
  html = html.replace(/`([^`]+)`/g,
    '<code class="bg-ctp-mantle px-1 rounded text-xs">$1</code>');

  // Bold: **...**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic: *...*
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // Links: [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
    '<a class="text-indigo-400 hover:underline" href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered list items: - item
  html = html.replace(/^- (.+)$/gm, '<li class="ml-4 list-disc">$1</li>');

  // Ordered list items: 1. item
  html = html.replace(/^\d+\. (.+)$/gm, '<li class="ml-4 list-decimal">$1</li>');

  return html;
}
