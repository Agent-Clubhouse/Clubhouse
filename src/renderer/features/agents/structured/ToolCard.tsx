import { useState, useMemo } from 'react';
import type { ToolStart, ToolEnd } from '../../../../shared/structured-events';

export type ToolStatus = 'running' | 'completed' | 'error';

interface Props {
  tool: ToolStart;
  output: string;
  end?: ToolEnd;
  status: ToolStatus;
}

/**
 * Renders a single tool invocation lifecycle (tool_start → tool_output → tool_end).
 * Expanded while running, collapsed when completed, always expanded on error.
 */
export function ToolCard({ tool, output, end, status }: Props) {
  const [expanded, setExpanded] = useState(status === 'running' || status === 'error');
  const [inputExpanded, setInputExpanded] = useState(false);

  // Auto-expand running tools, keep error tools expanded
  const isExpanded = status === 'error' || (status === 'running' ? true : expanded);

  const primaryInput = useMemo(() => getPrimaryInput(tool), [tool]);

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        status === 'error'
          ? 'border-red-500/40 bg-red-500/5'
          : 'border-surface-0 bg-ctp-mantle'
      }`}
      data-testid="tool-card"
      data-tool-id={tool.id}
      data-tool-status={status}
    >
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <StatusIcon status={status} />
        <span className="text-xs font-medium text-ctp-accent">{tool.displayVerb}</span>
        {primaryInput && (
          <span className="text-xs text-ctp-subtext0 font-mono truncate">{primaryInput}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {end && (
            <span className="text-[10px] text-ctp-subtext0 tabular-nums">
              {formatDuration(end.durationMs)}
            </span>
          )}
          <ChevronIcon expanded={isExpanded} />
        </span>
      </button>

      {/* Expandable body */}
      {isExpanded && (
        <div className="border-t border-surface-0">
          {/* Input section */}
          <button
            className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[10px] text-ctp-subtext0 hover:bg-surface-0/30 transition-colors cursor-pointer"
            onClick={() => setInputExpanded((e) => !e)}
          >
            <ChevronIcon expanded={inputExpanded} />
            <span>Input</span>
          </button>
          {inputExpanded && (
            <pre className="px-3 pb-2 text-xs text-ctp-subtext1 font-mono overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          )}

          {/* Output section */}
          {(output || status === 'running') && (
            <div className="border-t border-surface-0">
              <div className="px-3 py-1.5 text-[10px] text-ctp-subtext0 flex items-center gap-1.5">
                Output
                {status === 'running' && (
                  <span className="text-ctp-accent animate-pulse">(streaming...)</span>
                )}
              </div>
              {output && (
                <pre
                  className="px-3 pb-2 text-xs text-ctp-subtext1 font-mono overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
                  data-testid="tool-output"
                >
                  {output}
                </pre>
              )}
            </div>
          )}

          {/* Error result */}
          {end && end.status === 'error' && (
            <div className="border-t border-surface-0 px-3 py-2">
              <span className="text-xs text-red-400">{end.result}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolStatus }) {
  if (status === 'running') {
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
  // completed
  return (
    <svg className="w-3.5 h-3.5 text-green-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <polyline points="5.5 8 7.5 10 10.5 6" />
    </svg>
  );
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

/** Extract the most relevant input field for display in the header. */
function getPrimaryInput(tool: ToolStart): string | null {
  const { input } = tool;
  // Common patterns: file_path, command, query, pattern, url
  for (const key of ['file_path', 'command', 'query', 'pattern', 'url', 'path']) {
    if (typeof input[key] === 'string') return input[key] as string;
  }
  return null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
