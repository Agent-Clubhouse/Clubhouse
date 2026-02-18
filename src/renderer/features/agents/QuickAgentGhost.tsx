import { useState } from 'react';
import { CompletedQuickAgent } from '../../../shared/types';
import { TranscriptViewer } from './TranscriptViewer';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { getOrchestratorColor, getModelColor, getOrchestratorLabel, formatModelLabel } from './orchestrator-colors';

interface Props {
  completed: CompletedQuickAgent;
  onDismiss: () => void;
  onDelete?: () => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
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

function ExitBadge({ exitCode, cancelled }: { exitCode: number; cancelled?: boolean }) {
  if (cancelled) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-yellow-500/20 text-yellow-400">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
        Cancelled
      </span>
    );
  }
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
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const showToggle = completed.filesModified.length > 3;
  const visibleFiles = filesExpanded ? completed.filesModified : completed.filesModified.slice(0, 3);

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <div className="w-[360px] max-w-full max-h-[80vh] bg-ctp-mantle border border-surface-0 rounded-xl p-5 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ExitBadge exitCode={completed.exitCode} cancelled={completed.cancelled} />
            {completed.headless && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-indigo-500/20 text-indigo-400">
                Headless
              </span>
            )}
            {(() => {
              const orchId = completed.orchestrator || 'claude-code';
              const c = getOrchestratorColor(orchId);
              return (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px]"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {getOrchestratorLabel(orchId, allOrchestrators)}
                </span>
              );
            })()}
            {completed.model && (() => {
              const c = getModelColor(completed.model);
              return (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono"
                  style={{ backgroundColor: c.bg, color: c.text }}>
                  {formatModelLabel(completed.model)}
                </span>
              );
            })()}
          </div>
          <span className="text-xs text-ctp-subtext0 flex-shrink-0">{relativeTime(completed.completedAt)}</span>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
          {/* Cost / Duration / Tools row */}
          {(completed.durationMs != null || (completed.toolsUsed && completed.toolsUsed.length > 0)) && (
            <div className="flex items-center gap-2 flex-wrap">
              {completed.durationMs != null && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-ctp-surface0 text-ctp-subtext1">
                  {formatDuration(completed.durationMs)}
                </span>
              )}
              {completed.toolsUsed && completed.toolsUsed.map((tool) => (
                <span key={tool} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-ctp-surface0 text-ctp-subtext0 font-mono">
                  {tool}
                </span>
              ))}
            </div>
          )}

          {/* Mission */}
          <div className="overflow-hidden">
            <div className="text-xs text-ctp-subtext0 mb-1">Mission</div>
            <p className="text-sm text-ctp-text line-clamp-3 break-words">{completed.mission}</p>
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

          {/* Transcript viewer for headless agents */}
          {completed.headless && (
            <div>
              <button
                onClick={() => setTranscriptOpen(!transcriptOpen)}
                className="text-xs text-indigo-400 hover:text-indigo-300 cursor-pointer flex items-center gap-1"
              >
                <svg
                  width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`transition-transform ${transcriptOpen ? 'rotate-90' : ''}`}
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {transcriptOpen ? 'Hide transcript' : 'View transcript'}
              </button>
              {transcriptOpen && (
                <div className="mt-2 border border-surface-0 rounded-lg overflow-hidden bg-ctp-base">
                  <TranscriptViewer agentId={completed.id} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions — pinned at bottom */}
        <div className="flex gap-2 pt-3 flex-shrink-0">
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
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  return (
    <div
      className={`flex items-center gap-2 py-2 group hover:bg-surface-0 transition-colors cursor-pointer ${isNested ? 'pl-7 pr-3' : 'px-3'}`}
      onClick={onSelect}
    >
      {/* Exit indicator */}
      <span className="flex-shrink-0">
        {completed.cancelled ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#facc15" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
          </svg>
        ) : completed.exitCode === 0 ? (
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
        <div className="flex items-center gap-1 mt-0.5">
          {(() => {
            const orchId = completed.orchestrator || 'claude-code';
            const c = getOrchestratorColor(orchId);
            return (
              <span className="inline-flex items-center px-1 py-0 rounded text-[9px] flex-shrink-0"
                style={{ backgroundColor: c.bg, color: c.text }}>
                {getOrchestratorLabel(orchId, allOrchestrators)}
              </span>
            );
          })()}
          {completed.model && (() => {
            const c = getModelColor(completed.model);
            return (
              <span className="inline-flex items-center px-1 py-0 rounded text-[9px] font-mono flex-shrink-0"
                style={{ backgroundColor: c.bg, color: c.text }}>
                {formatModelLabel(completed.model)}
              </span>
            );
          })()}
          <span className="text-[10px] text-ctp-subtext0 truncate">
            {completed.summary || 'Interrupted'}
            {completed.filesModified.length > 0 && ` · ${completed.filesModified.length} file${completed.filesModified.length === 1 ? '' : 's'}`}
            {completed.durationMs != null && ` · ${formatDuration(completed.durationMs)}`}
          </span>
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
