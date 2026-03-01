import { useState, useCallback } from 'react';
import type { UsageEvent } from '../../../../shared/structured-events';
import { CostTracker } from './CostTracker';

interface Props {
  agentId: string;
  elapsed: number;
  usage: UsageEvent | null;
  isComplete: boolean;
  onStop: () => void;
  onSendMessage: (message: string) => void;
}

/**
 * Bottom action bar with stop button, message input, cost display, and elapsed timer.
 */
export function ActionBar({ agentId: _agentId, elapsed, usage, isComplete, onStop, onSendMessage }: Props) {
  const [message, setMessage] = useState('');

  const handleSend = useCallback(() => {
    const trimmed = message.trim();
    if (!trimmed) return;
    onSendMessage(trimmed);
    setMessage('');
  }, [message, onSendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className="border-t border-surface-0 bg-ctp-mantle px-3 py-2 flex items-center gap-3"
      data-testid="action-bar"
    >
      {/* Message input */}
      {!isComplete && (
        <div className="flex-1 flex items-center gap-2">
          <input
            type="text"
            className="flex-1 bg-ctp-base border border-surface-0 rounded px-2 py-1 text-xs text-ctp-text placeholder-ctp-subtext0 outline-none focus:border-indigo-500/50 transition-colors"
            placeholder="Send a message..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            data-testid="message-input"
          />
          <button
            className="px-2 py-1 text-xs rounded bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-default cursor-pointer"
            onClick={handleSend}
            disabled={!message.trim()}
          >
            Send
          </button>
        </div>
      )}

      {/* Spacer when complete */}
      {isComplete && <div className="flex-1" />}

      {/* Cost tracker */}
      {usage && <CostTracker usage={usage} />}

      {/* Elapsed time */}
      <span className="text-[10px] text-ctp-subtext0 tabular-nums">{formatElapsed(elapsed)}</span>

      {/* Stop button */}
      {!isComplete && (
        <button
          className="px-3 py-1 text-xs rounded border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors cursor-pointer"
          onClick={onStop}
          data-testid="stop-button"
        >
          Stop
        </button>
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}
