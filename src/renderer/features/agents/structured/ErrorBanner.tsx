import { useState } from 'react';
import type { ErrorEvent } from '../../../../shared/structured-events';

interface Props {
  error: ErrorEvent;
}

/**
 * Renders error events as a red banner with error code and message.
 */
export function ErrorBanner({ error }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <div
      className="border border-red-500/40 bg-red-500/10 rounded-lg overflow-hidden"
      data-testid="error-banner"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <svg className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="5" x2="8" y2="8.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-red-400">{error.code}</span>
            {error.toolId && (
              <span className="text-[10px] text-ctp-subtext0 font-mono">({error.toolId})</span>
            )}
          </div>
          <p className="text-xs text-ctp-subtext1 mt-0.5 break-words">{error.message}</p>
        </div>
        <button
          className="text-ctp-subtext0 hover:text-ctp-text transition-colors flex-shrink-0 cursor-pointer"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss error"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
