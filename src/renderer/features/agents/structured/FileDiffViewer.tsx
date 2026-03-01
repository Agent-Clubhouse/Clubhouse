import { useState, useMemo } from 'react';
import type { FileDiff } from '../../../../shared/structured-events';

interface Props {
  diff: FileDiff;
  defaultExpanded?: boolean;
}

interface DiffLine {
  type: 'added' | 'removed' | 'context' | 'header';
  content: string;
  oldNum?: number;
  newNum?: number;
}

/**
 * Renders a file_diff event as a syntax-highlighted inline diff.
 */
export function FileDiffViewer({ diff, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const lines = useMemo(() => parseDiff(diff.diff), [diff.diff]);

  const stats = useMemo(() => {
    let added = 0, removed = 0;
    for (const l of lines) {
      if (l.type === 'added') added++;
      else if (l.type === 'removed') removed++;
    }
    return { added, removed };
  }, [lines]);

  return (
    <div className="border border-surface-0 rounded-lg overflow-hidden bg-ctp-mantle" data-testid="file-diff-viewer">
      {/* Header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-0/50 transition-colors cursor-pointer"
        onClick={() => setExpanded((e) => !e)}
      >
        <ChangeTypeBadge type={diff.changeType} />
        <span className="text-xs font-mono text-ctp-text truncate">{diff.path}</span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] tabular-nums">
          {stats.added > 0 && <span className="text-green-400">+{stats.added}</span>}
          {stats.removed > 0 && <span className="text-red-400">-{stats.removed}</span>}
        </span>
      </button>

      {/* Diff lines */}
      {expanded && (
        <div className="border-t border-surface-0 overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <tbody>
              {lines.map((line, i) => (
                <tr
                  key={i}
                  className={lineRowClass(line.type)}
                >
                  {line.type === 'header' ? (
                    <td colSpan={3} className="px-3 py-0.5 text-ctp-subtext0 bg-surface-0/30">
                      {line.content}
                    </td>
                  ) : (
                    <>
                      <td className="w-8 text-right pr-1 text-ctp-subtext0/50 select-none">
                        {line.oldNum ?? ''}
                      </td>
                      <td className="w-8 text-right pr-2 text-ctp-subtext0/50 select-none border-r border-surface-0">
                        {line.newNum ?? ''}
                      </td>
                      <td className="px-2 py-0 whitespace-pre-wrap break-words">
                        <span className={linePrefix(line.type)}>{linePrefixChar(line.type)}</span>
                        {line.content}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ChangeTypeBadge({ type }: { type: FileDiff['changeType'] }) {
  const label = { create: 'Created', modify: 'Modified', delete: 'Deleted' }[type];
  const color = {
    create: 'text-green-400 bg-green-500/15',
    modify: 'text-indigo-400 bg-indigo-500/15',
    delete: 'text-red-400 bg-red-500/15',
  }[type];

  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded ${color}`}>{label}</span>
  );
}

function lineRowClass(type: DiffLine['type']): string {
  switch (type) {
    case 'added': return 'bg-green-500/8';
    case 'removed': return 'bg-red-500/8';
    default: return '';
  }
}

function linePrefix(type: DiffLine['type']): string {
  switch (type) {
    case 'added': return 'text-green-400 select-none mr-1';
    case 'removed': return 'text-red-400 select-none mr-1';
    default: return 'text-transparent select-none mr-1';
  }
}

function linePrefixChar(type: DiffLine['type']): string {
  switch (type) {
    case 'added': return '+';
    case 'removed': return '-';
    default: return ' ';
  }
}

/** Parse unified diff format into structured lines. */
function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldNum = parseInt(match[1], 10);
        newNum = parseInt(match[2], 10);
      }
      lines.push({ type: 'header', content: line });
    } else if (line.startsWith('+')) {
      lines.push({ type: 'added', content: line.slice(1), newNum });
      newNum++;
    } else if (line.startsWith('-')) {
      lines.push({ type: 'removed', content: line.slice(1), oldNum });
      oldNum++;
    } else if (line.startsWith(' ') || line === '') {
      lines.push({ type: 'context', content: line.slice(1), oldNum, newNum });
      oldNum++;
      newNum++;
    }
    // Skip diff header lines (--- a/..., +++ b/..., etc.)
  }

  return lines;
}
