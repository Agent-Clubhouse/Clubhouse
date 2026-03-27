import { useUIStore } from '../../stores/uiStore';

interface Props {
  onReset: () => void;
}

/**
 * Header bar for the assistant panel.
 * Shows robot icon, title, new conversation button, and classic help toggle.
 */
export function AssistantHeader({ onReset }: Props) {
  const setExplorerTab = useUIStore((s) => s.setExplorerTab);

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-surface-0 bg-ctp-mantle flex-shrink-0">
      <div className="flex items-center gap-2">
        {/* Robot icon */}
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-ctp-accent flex-shrink-0"
        >
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <line x1="12" y1="7" x2="12" y2="11" />
          <line x1="8" y1="16" x2="8" y2="16.01" />
          <line x1="16" y1="16" x2="16" y2="16.01" />
        </svg>
        <span className="text-sm font-semibold text-ctp-text">Clubhouse Assistant</span>
      </div>

      <div className="flex items-center gap-1">
        {/* New conversation button */}
        <button
          onClick={onReset}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 rounded transition-colors cursor-pointer"
          title="New conversation"
          data-testid="assistant-reset-button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
        </button>

        {/* Classic Help button */}
        <button
          onClick={() => setExplorerTab('help')}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:bg-surface-0 rounded transition-colors cursor-pointer"
          title="Classic Help"
          data-testid="classic-help-button"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>Help docs</span>
        </button>
      </div>
    </div>
  );
}
