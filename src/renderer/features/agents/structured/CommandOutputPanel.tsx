import { useState, useMemo, useCallback } from 'react';
import type { CommandOutput } from '../../../../shared/structured-events';
import { useThemeStore } from '../../../stores/themeStore';

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
  const theme = useThemeStore((s) => s.theme);

  const isRunning = command.status === 'running';
  const isFailed = command.status === 'failed';

  const outputLines = useMemo(() => command.output.split('\n'), [command.output]);
  const isTruncated = !showAll && outputLines.length > MAX_LINES_COLLAPSED;
  const displayLines = isTruncated ? outputLines.slice(0, MAX_LINES_COLLAPSED) : outputLines;
  const displayOutput = displayLines.join('\n');

  // Build ANSI color map from current theme's palette
  const getAnsiColor = useCallback(
    (code: number): string | undefined => {
      const c: typeof theme.colors = theme.colors;
      const ansiMap: Record<number, string> = {
        // Standard colors (30-37)
        30: c.text,           // black → text color
        31: c.error,          // red
        32: c.success,        // green
        33: c.warning,        // yellow
        34: c.info,           // blue
        35: c.link,           // magenta
        36: c.accent,         // cyan
        37: c.subtext1,       // white → muted text
        // Bright colors (90-97)
        90: c.subtext0,       // bright black → more muted text
        91: c.error,          // bright red
        92: c.success,        // bright green
        93: c.warning,        // bright yellow
        94: c.info,           // bright blue
        95: c.link,           // bright magenta
        96: c.accent,         // bright cyan
        97: c.text,           // bright white → text
      };
      return ansiMap[code];
    },
    [theme],
  );

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
            dangerouslySetInnerHTML={{ __html: renderAnsi(displayOutput, getAnsiColor) }}
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

/** Render basic ANSI color codes to HTML spans using theme-aware colors. */
function renderAnsi(text: string, getAnsiColor: (code: number) => string | undefined): string {
  // Escape HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Replace ANSI escape sequences
  // eslint-disable-next-line no-control-regex
  html = html.replace(/\x1b\[(\d+(?:;\d+)*)m/g, (_match, codes: string) => {
    const parts = codes.split(';').map(Number);
    const styles: string[] = [];
    let isBold = false;
    for (const code of parts) {
      if (code === 0) return '</span>';
      if (code === 1) {
        isBold = true;
        continue;
      }
      const color = getAnsiColor(code);
      if (color) styles.push(`color:${color}`);
    }
    if (styles.length === 0 && !isBold) return '';
    const styleAttr = styles.join(';') + (isBold ? ';font-weight:bold' : '');
    return `<span style="${styleAttr}">`;
  });

  // Clean up any remaining escape sequences
  // eslint-disable-next-line no-control-regex
  html = html.replace(/\x1b\[[^m]*m/g, '');

  return html;
}
