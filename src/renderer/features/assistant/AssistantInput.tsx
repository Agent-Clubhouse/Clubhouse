import { useState, useCallback, useRef, useEffect } from 'react';

interface Props {
  onSend: (message: string) => void;
  disabled?: boolean;
}

/**
 * Bottom-docked input bar with textarea and send button.
 * Enter sends, Shift+Enter inserts newline.
 */
export function AssistantInput({ onSend, disabled = false }: Props) {
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setMessage('');
  }, [message, disabled, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [message]);

  return (
    <div
      className="border-t border-surface-0 bg-ctp-mantle px-3 py-2 flex items-end gap-2 flex-shrink-0"
      data-testid="assistant-input"
    >
      <textarea
        ref={textareaRef}
        className="flex-1 bg-ctp-base border border-surface-0 rounded px-2 py-1.5 text-xs text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-ctp-accent/50 transition-colors resize-none overflow-hidden"
        placeholder="Ask the assistant..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
        data-testid="assistant-message-input"
      />
      <button
        className="px-3 py-1.5 text-xs rounded bg-ctp-accent text-white hover:opacity-90 transition-colors disabled:opacity-40 disabled:cursor-default cursor-pointer flex-shrink-0"
        onClick={handleSend}
        disabled={!message.trim() || disabled}
        data-testid="assistant-send-button"
      >
        Send
      </button>
    </div>
  );
}
