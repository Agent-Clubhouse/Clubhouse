import type { ManagedPreview } from '../../../shared/managed-agents-types';

const textClass = 'min-w-0 px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap [overflow-wrap:anywhere]';

/** Each label and its source share a row. Either cell can grow without covering the next block. */
export function BlockInstructionsPreview({ blocks, text, raw = false }: { blocks: ManagedPreview['blocks']; text: string; raw?: boolean }) {
  const lineOffsets = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') lineOffsets.push(index + 1);
  const ranges = blocks.map((block) => ({
    ...block,
    startLine: raw ? block.rawStartLine : block.startLine,
    endLine: raw ? block.rawEndLine : block.endLine,
  }));
  // Never apply ranges for one representation to another, or manufacture separators from stale metadata.
  const mapped = ranges.length > 0 && ranges.every((block, index) => (
    Number.isInteger(block.startLine) && Number.isInteger(block.endLine)
    && block.startLine === (index ? ranges[index - 1].endLine + 2 : 1)
    && block.endLine >= block.startLine && block.endLine <= lineOffsets.length
  )) && ranges[ranges.length - 1].endLine === lineOffsets.length;
  if (!mapped) return (
    <>
      {blocks.length > 0 && <p className="px-3 py-2 text-xs text-ctp-overlay1" data-testid="managed-preview-unmapped">Block boundaries are unavailable for this text. Showing it intact.</p>}
      <pre className={textClass} data-testid="managed-preview-text">{text || 'No instructions.'}</pre>
    </>
  );
  return (
    <ol className="@container min-w-0" aria-label="Instruction blocks and their text" data-testid="managed-preview-text">
      {ranges.map((block, index) => {
        const next = ranges[index + 1];
        // Include the separator in the preceding block. Joining these texts gives the exact source.
        const content = text.slice(lineOffsets[block.startLine - 1], next ? lineOffsets[next.startLine - 1] : text.length);
        return (
          <li key={`${block.id}-${index}`} className="grid grid-cols-1 @min-[420px]:grid-cols-[148px_minmax(0,1fr)] items-start" data-testid="managed-preview-block" data-start-line={block.startLine} data-end-line={block.endLine}>
            <div className="min-w-0 h-full bg-ctp-mantle px-3 py-2 text-[11.5px] leading-[1.6] [overflow-wrap:anywhere]" data-testid="managed-preview-block-label">
              <span className="block text-ctp-subtext1 font-medium">{index + 1} {block.name}</span>
              <span className="text-ctp-overlay1">{block.builtin ? 'Built-in' : 'Custom'} · lines {block.startLine} to {block.endLine}</span>
            </div>
            <pre className={textClass} data-testid="managed-preview-block-text">{content}</pre>
          </li>
        );
      })}
    </ol>
  );
}
