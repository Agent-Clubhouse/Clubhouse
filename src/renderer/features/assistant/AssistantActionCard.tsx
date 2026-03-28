import { useState, useMemo } from 'react';
import type { ActionCardData, ActionCardStatus } from './types';

interface Props {
  action: ActionCardData;
  onApprove?: (actionId: string) => void;
  onSkip?: (actionId: string) => void;
}

/** Tool-name patterns that represent canvas/project/agent creation. */
const CREATION_TOOLS = new Set([
  'create_project', 'create_canvas', 'create_agent',
  'add_card', 'add_zone', 'add_wire', 'update_card',
]);

/** Map raw tool names to human-friendly labels. */
const TOOL_LABELS: Record<string, string> = {
  create_project: 'Create project',
  create_canvas: 'Create canvas',
  create_agent: 'Create agent',
  add_card: 'Add card',
  add_zone: 'Add zone',
  add_wire: 'Add wire',
  update_card: 'Update card',
  search_help: 'Search help',
  list_projects: 'List projects',
  list_agents: 'List agents',
  read_file: 'Read file',
  write_file: 'Write file',
  run_command: 'Run command',
};

function humanToolName(raw: string): string {
  return TOOL_LABELS[raw] || raw.replace(/_/g, ' ');
}

/**
 * Format error messages for humans.
 * Strip JSON wrappers, extract message fields, and truncate long traces.
 */
function humanError(raw: string): string {
  // Try to parse as JSON and extract a message field
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      if (parsed.message) return String(parsed.message);
      if (parsed.error) return String(parsed.error);
    }
  } catch { /* not JSON, use as-is */ }

  // Strip common wrapper noise
  let msg = raw.replace(/^Error:\s*/i, '');

  // Truncate stack traces
  const stackIdx = msg.indexOf('\n    at ');
  if (stackIdx > 0) msg = msg.slice(0, stackIdx);

  // Cap length
  if (msg.length > 300) msg = msg.slice(0, 297) + '...';

  return msg;
}

/** Build a one-line result summary for creation tools. */
function buildResultSummary(action: ActionCardData): string | null {
  if (action.resultSummary) return action.resultSummary;
  if (action.status !== 'completed' || !action.output) return null;

  if (!CREATION_TOOLS.has(action.toolName)) return null;

  try {
    const parsed = JSON.parse(action.output);
    if (typeof parsed === 'object' && parsed !== null) {
      const name = parsed.name || parsed.title || parsed.id;
      const type = action.toolName.replace(/^(create|add)_/, '');
      if (name) return `${type} "${name}" created`;
    }
  } catch { /* not JSON */ }

  return null;
}

/**
 * Inline card showing a tool execution with status, expandable details,
 * and approve/skip controls for pending actions.
 */
export function AssistantActionCard({ action, onApprove, onSkip }: Props) {
  const [expanded, setExpanded] = useState(false);
  const isAwaitingApproval = action.status === 'pending_approval';
  const isExpanded = action.status === 'error' || isAwaitingApproval || expanded;
  const summary = useMemo(() => buildResultSummary(action), [action]);

  return (
    <div
      className={`border rounded-lg overflow-hidden ${statusBorderClass(action.status)}`}
      data-testid="assistant-action-card"
      data-status={action.status}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <StatusIcon status={action.status} />
        <span className="text-xs font-medium text-ctp-accent truncate">
          {humanToolName(action.toolName)}
        </span>
        {action.description && (
          <span className="text-xs text-ctp-subtext0 truncate">{action.description}</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {action.status === 'completed' && summary && (
            <span className="text-[10px] text-green-400 truncate max-w-[140px]">{summary}</span>
          )}
          {action.durationMs != null && action.status === 'completed' && (
            <span className="text-[10px] text-ctp-subtext0 tabular-nums">
              {action.durationMs < 1000 ? `${action.durationMs}ms` : `${(action.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          <ChevronIcon expanded={isExpanded} />
        </span>
      </button>

      {/* Approval controls */}
      {isAwaitingApproval && (
        <div className="border-t border-surface-0 px-3 py-2 flex items-center gap-2 bg-ctp-accent/5">
          <span className="text-xs text-ctp-subtext1 mr-auto">
            The assistant wants to perform this action
          </span>
          <button
            className="px-3 py-1 text-xs font-medium rounded bg-ctp-accent text-ctp-base hover:opacity-90 transition-opacity cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onApprove?.(action.id); }}
            data-testid="action-approve"
          >
            Approve
          </button>
          <button
            className="px-3 py-1 text-xs font-medium rounded border border-surface-0 text-ctp-subtext0 hover:text-ctp-text hover:border-ctp-accent/40 transition-colors cursor-pointer"
            onClick={(e) => { e.stopPropagation(); onSkip?.(action.id); }}
            data-testid="action-skip"
          >
            Skip
          </button>
        </div>
      )}

      {/* Expandable body — tool input, output, errors */}
      {isExpanded && (
        <div className="border-t border-surface-0">
          {/* Input parameters */}
          {action.input && Object.keys(action.input).length > 0 && (
            <details className="group">
              <summary className="px-3 py-1.5 text-[10px] text-ctp-subtext0 cursor-pointer hover:text-ctp-subtext1 select-none">
                Parameters
              </summary>
              <pre className="px-3 pb-2 text-xs text-ctp-subtext1 font-mono overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
                {formatInput(action.input)}
              </pre>
            </details>
          )}

          {/* Output */}
          {action.output && action.status !== 'error' && (
            <details className="group" open={action.status === 'completed' && !!summary}>
              <summary className="px-3 py-1.5 text-[10px] text-ctp-subtext0 cursor-pointer hover:text-ctp-subtext1 select-none">
                Result
              </summary>
              <pre className="px-3 pb-2 text-xs text-ctp-subtext1 font-mono overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
                {action.output}
              </pre>
            </details>
          )}

          {/* Error */}
          {action.error && (
            <div className="px-3 py-2">
              <p className="text-xs text-red-400">{humanError(action.error)}</p>
            </div>
          )}

          {/* Skipped */}
          {action.status === 'skipped' && (
            <div className="px-3 py-2">
              <span className="text-xs text-ctp-subtext0 italic">Action skipped by user</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input).map(([k, v]) => {
    const val = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
    return `${k}: ${val}`;
  });
  return entries.join('\n');
}

function statusBorderClass(status: ActionCardStatus): string {
  switch (status) {
    case 'error': return 'border-red-500/40 bg-red-500/5';
    case 'pending_approval': return 'border-ctp-accent/40 bg-ctp-accent/5';
    case 'skipped': return 'border-surface-0 bg-ctp-mantle opacity-60';
    case 'running': return 'border-ctp-accent/20 bg-ctp-mantle';
    default: return 'border-surface-0 bg-ctp-mantle';
  }
}

function StatusIcon({ status }: { status: ActionCardStatus }) {
  switch (status) {
    case 'pending_approval':
      return (
        <svg className="w-3.5 h-3.5 text-ctp-accent" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="5" x2="8" y2="8.5" />
          <circle cx="8" cy="11" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'pending':
    case 'running':
      return (
        <svg className="w-3.5 h-3.5 text-ctp-accent animate-spin" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
          <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'completed':
      return (
        <svg className="w-3.5 h-3.5 text-green-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="8" cy="8" r="6" />
          <polyline points="5.5 8 7.5 10 10.5 6" />
        </svg>
      );
    case 'error':
      return (
        <svg className="w-3.5 h-3.5 text-red-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <line x1="6" y1="6" x2="10" y2="10" />
          <line x1="10" y1="6" x2="6" y2="10" />
        </svg>
      );
    case 'skipped':
      return (
        <svg className="w-3.5 h-3.5 text-ctp-subtext0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="8" cy="8" r="6" />
          <line x1="5" y1="8" x2="11" y2="8" />
        </svg>
      );
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`w-3 h-3 text-ctp-subtext0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="6 4 10 8 6 12" />
    </svg>
  );
}
