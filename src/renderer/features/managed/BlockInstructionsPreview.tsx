import type { ManagedPreview } from '../../../shared/managed-agents-types';

const textClass = 'min-w-0 px-3 py-2 font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap [overflow-wrap:anywhere]';

/** Each label and its source share a row. Either cell can grow without covering the next block. */
export function BlockInstructionsPreview({ blocks, text }: { blocks: ManagedPreview['blocks']; text: string }) {
  if (!blocks.length) return <pre className={textClass} data-testid="managed-preview-text">{text || 'No instructions.'}</pre>;
  const lines = text.split('\n');
  return (
    <ol className="@container min-w-0" aria-label="Instruction blocks and their text" data-testid="managed-preview-text">
      {blocks.map((block, index) => {
        const next = blocks[index + 1];
        // Include the separator in the preceding block. Joining these texts gives the exact source.
        const content = lines.slice(block.startLine - 1, next ? next.startLine - 1 : undefined).join('\n') + (next ? '\n' : '');
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
