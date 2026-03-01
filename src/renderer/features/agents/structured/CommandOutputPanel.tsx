import { useState, useMemo } from 'react';
import type { CommandOutput } from '../../../../shared/structured-events';

const MAX_LINES_COLLAPSED = 50;

interface Props {
  command: CommandOutput;
  defaultExpanded?: boolean;
}

/**
 * Renders command_output events with streaming shell output and basic ANSI color support.
 */
export function CommandOutputPanel({ command, defaultExpanded = true }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showAll, setShowAll] = useState(false);

  const isRunning = command.status === 'running';
  const isFailed = command.status === 'failed';

  const outputLines = useMemo(() => command.output.split('\n'), [command.output]);
  const isTruncated = !showAll && outputLines.length > MAX_LINES_COLLAPSED;
  const displayLines = isTruncated ? outputLines.slice(0, MAX_LINES_COLLAPSED) : outputLines;
  const displayOutput = displayLines.join('\n');

  return (
    <div
      className={`border rounded-lg overflow-hidden ${
        isFailed ? 'border-red-500/30 bg-red-500/5' : 'border-surface-0 bg-ctp-mantle'
      }`}
      data-testid="command-output-panel"
    >
      {/* Header: command + status */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <span className="text-xs text-ctp-subtext0">$</span>
        <span className="text-xs font-mono text-ctp-text truncate">{command.command}</span>
        <span className="ml-auto">
          {isRunning ? (
            <span className="text-[10px] text-ctp-accent flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-ctp-accent animate-pulse" />
              Running
            </span>
          ) : isFailed ? (
            <span className="text-[10px] text-red-400">exit {command.exitCode ?? '?'}</span>
          ) : (
            <span className="text-[10px] text-green-400">exit 0</span>
          )}
        </span>
      </button>

      {/* Output body */}
      {expanded && command.output && (
        <div className="border-t border-surface-0">
          <pre
            className="px-3 py-2 text-xs font-mono text-ctp-subtext1 overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-words"
            data-testid="command-output-text"
            dangerouslySetInnerHTML={{ __html: renderAnsi(displayOutput) }}
          />
          {isTruncated && (
            <button
              className="w-full py-1 text-[10px] text-ctp-subtext0 hover:text-ctp-text border-t border-surface-0 transition-colors cursor-pointer"
              onClick={() => setShowAll(true)}
            >
              Show all ({outputLines.length} lines)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Render basic ANSI color codes to HTML spans. Supports bold + 8 standard colors. */
function renderAnsi(text: string): string {
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Replace ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  html = html.replace(/\x1b\[(\d+(?:;\d+)*)m/g, (_match, codes: string) => {
    const parts = codes.split(';').map(Number);
    const classes: string[] = [];
    for (const code of parts) {
      const cls = ANSI_MAP[code];
      if (cls) classes.push(cls);
      if (code === 0) return '</span>';
    }
    return classes.length > 0 ? `<span class="${classes.join(' ')}">` : '';
  });

  // Clean up any remaining escape sequences
  // eslint-disable-next-line no-control-regex
  html = html.replace(/\x1b\[[^m]*m/g, '');

  return html;
}

const ANSI_MAP: Record<number, string> = {
  1: 'font-bold',
  30: 'text-gray-900',
  31: 'text-red-400',
  32: 'text-green-400',
  33: 'text-yellow-400',
  34: 'text-blue-400',
  35: 'text-purple-400',
  36: 'text-cyan-400',
  37: 'text-gray-300',
  90: 'text-gray-500',
  91: 'text-red-300',
  92: 'text-green-300',
  93: 'text-yellow-300',
  94: 'text-blue-300',
  95: 'text-purple-300',
  96: 'text-cyan-300',
  97: 'text-white',
};
