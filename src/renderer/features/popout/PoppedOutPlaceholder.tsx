import { useCallback } from 'react';

interface PoppedOutPlaceholderProps {
  /** The type of view that is popped out. */
  type: 'agent' | 'hub' | 'canvas';
  /** Optional name of the popped-out view (e.g. agent name, hub name). */
  name?: string;
  /** The windowId of the popout, used to focus or close it. */
  windowId: number;
}

const TYPE_LABELS: Record<string, string> = {
  agent: 'Agent',
  hub: 'Hub',
  canvas: 'Canvas',
};

export function PoppedOutPlaceholder({ type, name, windowId }: PoppedOutPlaceholderProps) {
  const label = name || TYPE_LABELS[type] || type;

  const handleGoToWindow = useCallback(() => {
    window.clubhouse.window.focusPopout(windowId);
  }, [windowId]);

  const handleCloseWindow = useCallback(() => {
    window.clubhouse.window.closePopout(windowId);
  }, [windowId]);

  return (
    <div
      className="flex items-center justify-center h-full bg-ctp-base"
      data-testid="popped-out-placeholder"
    >
      <div className="flex flex-col items-center gap-4 text-center max-w-sm px-6">
        {/* Pop-out icon */}
        <svg
          width="48"
          height="48"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-ctp-overlay0"
        >
          <polyline points="15 3 21 3 21 9" />
          <line x1="21" y1="3" x2="12" y2="12" />
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
        </svg>

        <div>
          <p className="text-sm font-medium text-ctp-text mb-1">
            {label} is open in a separate window
          </p>
          <p className="text-xs text-ctp-subtext0">
            This view has been popped out to avoid duplicate rendering.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleGoToWindow}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-ctp-accent text-ctp-base hover:opacity-90 transition-opacity"
            data-testid="popped-out-go-to-window"
          >
            Go to Window
          </button>
          <button
            onClick={handleCloseWindow}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text transition-colors"
            data-testid="popped-out-close-window"
          >
            Close Window
          </button>
        </div>
      </div>
    </div>
  );
}
