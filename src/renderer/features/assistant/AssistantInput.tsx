import { useState, useCallback, useRef, useEffect } from 'react';
import type { AssistantStatus } from './assistant-agent';

interface Props {
  onSend: (message: string) => void;
  disabled?: boolean;
  status: AssistantStatus;
}

/**
 * Bottom-docked input bar with auto-expanding textarea and send button.
 * Enter sends, Shift+Enter inserts newline.
 * Shows status-aware placeholder text.
 */
export function AssistantInput({ onSend, disabled = false, status }: Props) {
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setMessage('');
    // Reset textarea height after sending
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
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

  // Focus the textarea when component mounts
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const placeholder = status === 'responding'
    ? 'Waiting for response\u2026'
    : status === 'starting'
    ? 'Starting assistant\u2026'
    : 'Ask anything or type / for commands\u2026';

  const canSend = message.trim().length > 0 && !disabled;

  return (
    <div
      className="border-t border-surface-0 bg-ctp-mantle px-4 py-3 flex-shrink-0"
      data-testid="assistant-input"
    >
      <div className="max-w-[600px] mx-auto flex items-end gap-2">
        <textarea
          ref={textareaRef}
          className="flex-1 bg-ctp-base border border-surface-0 rounded-lg px-3 py-2 text-sm text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-ctp-accent/50 transition-colors resize-none overflow-hidden"
          placeholder={placeholder}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          data-testid="assistant-message-input"
        />
        <button
          className={`px-4 py-2 text-sm rounded-lg font-medium transition-colors flex-shrink-0 cursor-pointer ${
            canSend
              ? 'bg-ctp-accent text-white hover:opacity-90'
              : 'bg-ctp-accent/30 text-white/50 cursor-default'
          }`}
          onClick={handleSend}
          disabled={!canSend}
          data-testid="assistant-send-button"
        >
          Send
        </button>
      </div>
    </div>
  );
}
