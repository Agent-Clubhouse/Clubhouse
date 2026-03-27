import { useState } from 'react';
import type { ActionCardData, ActionCardStatus } from './types';

interface Props {
  action: ActionCardData;
}

/**
 * Inline card showing a tool execution with status, expandable details.
 * Stubbed for Phase 1 — will be wired to MCP tools in later phases.
 */
export function AssistantActionCard({ action }: Props) {
  const [expanded, setExpanded] = useState(action.status === 'running' || action.status === 'error');
  const isExpanded = action.status === 'error' || (action.status === 'running' ? true : expanded);

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        action.status === 'error'
          ? 'border-red-500/40 bg-red-500/5'
          : 'border-surface-0 bg-ctp-mantle'
      }`}
      data-testid="assistant-action-card"
      data-status={action.status}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <StatusIcon status={action.status} />
        <span className="text-xs font-medium text-ctp-accent">{action.toolName}</span>
        <span className="text-xs text-ctp-subtext0 truncate">{action.description}</span>
        <span className="ml-auto flex items-center gap-2">
          {action.durationMs != null && (
            <span className="text-[10px] text-ctp-subtext0 tabular-nums">
              {action.durationMs < 1000 ? `${action.durationMs}ms` : `${(action.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          <svg
            className={`w-3 h-3 text-ctp-subtext0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="6 4 10 8 6 12" />
          </svg>
        </span>
      </button>

      {/* Expandable body */}
      {isExpanded && (
        <div className="border-t border-surface-0">
          {action.output && (
            <pre className="px-3 py-2 text-xs text-ctp-subtext1 font-mono overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
              {action.output}
            </pre>
          )}
          {action.error && (
            <div className="px-3 py-2">
              <span className="text-xs text-red-400">{action.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: ActionCardStatus }) {
  if (status === 'pending' || status === 'running') {
    return (
      <svg className="w-3.5 h-3.5 text-ctp-accent animate-spin" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
        <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg className="w-3.5 h-3.5 text-red-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="8" cy="8" r="6" />
        <line x1="6" y1="6" x2="10" y2="10" />
        <line x1="10" y1="6" x2="6" y2="10" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-green-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <polyline points="5.5 8 7.5 10 10.5 6" />
    </svg>
  );
}
