import { useRef, useEffect } from 'react';

interface Props {
  label: string;
  detail?: string;
  shortcut?: string;
  matchIndices: number[];
  isSelected: boolean;
  onSelect: () => void;
  onHover: () => void;
}

function HighlightedLabel({ text, matchIndices }: { text: string; matchIndices: number[] }) {
  if (matchIndices.length === 0) {
    return <span>{text}</span>;
  }
  const matchSet = new Set(matchIndices);
  const parts: { text: string; highlighted: boolean }[] = [];
  let current = '';
  let isHighlighted = matchSet.has(0);

  for (let i = 0; i < text.length; i++) {
    const charHighlighted = matchSet.has(i);
    if (charHighlighted !== isHighlighted) {
      if (current) parts.push({ text: current, highlighted: isHighlighted });
      current = '';
      isHighlighted = charHighlighted;
    }
    current += text[i];
  }
  if (current) parts.push({ text: current, highlighted: isHighlighted });

  return (
    <span>
      {parts.map((p, i) =>
        p.highlighted ? (
          <span key={i} className="text-ctp-accent font-semibold">{p.text}</span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  );
}

export function CommandPaletteItem({ label, detail, shortcut, matchIndices, isSelected, onSelect, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected) {
      ref.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [isSelected]);

  return (
    <div
      ref={ref}
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`flex items-center justify-between px-4 py-2 cursor-pointer text-sm ${
        isSelected ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0'
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate">
          <HighlightedLabel text={label} matchIndices={matchIndices} />
        </span>
        {detail && (
          <span className="text-xs text-ctp-subtext0 truncate">{detail}</span>
        )}
      </div>
      {shortcut && (
        <kbd className="text-xs text-ctp-subtext0 bg-surface-0 px-1.5 py-0.5 rounded ml-3 flex-shrink-0">
          {shortcut}
        </kbd>
      )}
    </div>
  );
}
