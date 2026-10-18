import { useRef, useEffect } from 'react';
import { AgentAvatar } from '../agents/AgentAvatar';
import { StatusDot } from '../agents/agent-status';
import { ProjectSquare } from '../../chrome/sidebar/ProjectGroup';
import type { CommandIcon, CommandItem } from './command-registry';

interface Props {
  id: string;
  item: CommandItem;
  matchIndices: number[];
  isSelected: boolean;
  /** Only auto-scroll this item into view when true (keyboard navigation). */
  scrollOnSelect?: boolean;
  onSelect: () => void;
  onHover: () => void;
}

const ICONS: Record<CommandIcon, React.ReactNode> = {
  command: <path d="M5 7l5 5-5 5M12 17h7" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  help: <><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>,
  canvas: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /><path d="M10 6.5h4a2 2 0 0 1 2 2V14" /></>,
  host: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
};

function Lead({ item }: { item: CommandItem }) {
  if (item.agent && item.dot) {
    return (
      <span className="flex items-center gap-2 flex-shrink-0">
        <StatusDot dot={item.dot} />
        <AgentAvatar agent={item.agent} size="2xs" />
      </span>
    );
  }
  if (item.project) {
    return <span className="w-[18px] flex justify-center flex-shrink-0"><ProjectSquare project={item.project} iconUrl={item.projectIconUrl} /></span>;
  }
  return (
    <span className="w-[18px] flex justify-center flex-shrink-0 text-ctp-overlay1">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ICONS[item.icon ?? 'command']}
      </svg>
    </span>
  );
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
          <span key={i} className="text-ctp-text font-semibold">{p.text}</span>
        ) : (
          <span key={i}>{p.text}</span>
        )
      )}
    </span>
  );
}

/** One 30px palette row in the chrome menu style: lead, label, detail, shortcut. */
export function CommandPaletteItem({ id, item, matchIndices, isSelected, scrollOnSelect = true, onSelect, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSelected && scrollOnSelect) {
      ref.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [isSelected, scrollOnSelect]);

  return (
    <div
      ref={ref}
      id={id}
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      onMouseEnter={onHover}
      className={`h-[30px] mx-1 px-2.5 rounded-md flex items-center gap-2 cursor-pointer text-[13px] ${
        isSelected ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1'
      }`}
    >
      <Lead item={item} />
      <span className="truncate flex-shrink-0 max-w-[60%]">
        <HighlightedLabel text={item.label} matchIndices={matchIndices} />
      </span>
      {item.detail && (
        <span className="text-xs text-ctp-overlay1 truncate">{item.detail}</span>
      )}
      {item.shortcut && (
        <kbd className="ml-auto pl-3 flex-shrink-0 text-xs text-ctp-overlay1 font-sans">{item.shortcut}</kbd>
      )}
    </div>
  );
}
