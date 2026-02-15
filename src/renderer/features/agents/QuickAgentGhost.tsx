import { useState } from 'react';
import { CompletedQuickAgent } from '../../../shared/types';

interface Props {
  completed: CompletedQuickAgent;
  onDismiss: () => void;
  onDelete?: () => void;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ExitBadge({ exitCode }: { exitCode: number }) {
  if (exitCode === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-green-500/20 text-green-400">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Done
      </span>
    );
  }
  if (exitCode > 128) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-red-500/20 text-red-400">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        Killed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      Exit {exitCode}
    </span>
  );
}

export function QuickAgentGhost({ completed, onDismiss, onDelete }: Props) {
  const [filesExpanded, setFilesExpanded] = useState(false);
  const showToggle = completed.filesModified.length > 3;
  const visibleFiles = filesExpanded ? completed.filesModified : completed.filesModified.slice(0, 3);

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="w-[360px] bg-ctp-mantle border border-surface-0 rounded-xl p-5 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <ExitBadge exitCode={completed.exitCode} />
          <span className="text-xs text-ctp-subtext0">{relativeTime(completed.completedAt)}</span>
        </div>

        {/* Mission */}
        <div>
          <div className="text-xs text-ctp-subtext0 mb-1">Mission</div>
          <p className="text-sm text-ctp-text">{completed.mission}</p>
        </div>

        {/* Summary */}
        <div>
          <div className="text-xs text-ctp-subtext0 mb-1">Summary</div>
          {completed.summary ? (
            <p className="text-sm text-ctp-subtext1">{completed.summary}</p>
          ) : (
            <p className="text-sm text-ctp-overlay0 italic">Interrupted — no summary available</p>
          )}
        </div>

        {/* Files modified */}
        {completed.filesModified.length > 0 && (
          <div>
            <div className="text-xs text-ctp-subtext0 mb-1">
              Files modified ({completed.filesModified.length})
            </div>
            <div className="space-y-0.5">
              {visibleFiles.map((f) => (
                <div key={f} className="text-xs text-ctp-subtext1 font-mono truncate">{f}</div>
              ))}
            </div>
            {showToggle && (
              <button
                onClick={() => setFilesExpanded(!filesExpanded)}
                className="text-xs text-indigo-400 hover:text-indigo-300 mt-1 cursor-pointer"
              >
                {filesExpanded ? 'Show less' : `+${completed.filesModified.length - 3} more`}
              </button>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 mt-2">
          <button
            onClick={onDismiss}
            className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-surface-0
              hover:border-surface-2 hover:bg-surface-0 transition-colors cursor-pointer
              text-ctp-subtext1 hover:text-ctp-text"
          >
            Dismiss
          </button>
          {onDelete && (
            <button
              onClick={onDelete}
              className="flex-1 px-3 py-1.5 text-xs rounded-lg border border-red-500/30
                hover:bg-red-500/20 transition-colors cursor-pointer
                text-red-400"
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Compact ghost card for use in the sidebar AgentList */
export function QuickAgentGhostCompact({ completed, onDismiss, onDelete, onSelect, isNested }: Props & { onSelect?: () => void; isNested?: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 py-2 group hover:bg-surface-0 transition-colors cursor-pointer ${isNested ? 'pl-7 pr-3' : 'px-3'}`}
      onClick={onSelect}
    >
      {/* Exit indicator */}
      <span className="flex-shrink-0">
        {completed.exitCode === 0 ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : completed.exitCode > 128 ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#facc15" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        )}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ctp-text truncate">{completed.mission}</div>
        <div className="text-[10px] text-ctp-subtext0 truncate">
          {completed.summary || 'Interrupted'}
          {completed.filesModified.length > 0 && ` · ${completed.filesModified.length} file${completed.filesModified.length === 1 ? '' : 's'}`}
        </div>
      </div>

      {/* Timestamp */}
      <span className="text-[10px] text-ctp-overlay0 flex-shrink-0">{relativeTime(completed.completedAt)}</span>

      {/* Dismiss (trash icon) */}
      <button
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        className="w-4 h-4 flex items-center justify-center rounded hover:bg-red-500/20 text-ctp-overlay0 hover:text-red-400 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        title="Dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
        </svg>
      </button>
    </div>
  );
}
