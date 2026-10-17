import { useRef, useEffect } from 'react';
import { useCommandPaletteStore, PaletteMode } from '../../stores/commandPaletteStore';

const MODE_LABELS: Record<PaletteMode, string | null> = {
  all: null,
  commands: 'Commands',
  agents: 'Agents',
  projects: 'Projects',
  canvases: 'Canvases',
};

const PLACEHOLDERS: Record<PaletteMode, string> = {
  all: 'Search agents, projects, settings and commands',
  commands: 'Search commands and settings',
  agents: 'Search agents',
  projects: 'Search projects',
  canvases: 'Search canvases',
};

export const SearchIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
  </svg>
);

interface Props {
  listboxId: string;
  activeOptionId?: string;
}

/**
 * The palette's search row. With a prefix typed (> @ / #) the mode shows as a
 * plain label before the query, and the prefix itself stays in the field so
 * Backspace leaves the mode.
 */
export function CommandPaletteInput({ listboxId, activeOptionId }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useCommandPaletteStore((s) => s.query);
  const mode = useCommandPaletteStore((s) => s.mode);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const modeLabel = MODE_LABELS[mode];

  return (
    <div data-testid="command-palette-input-row" className="h-11 flex items-center gap-2.5 pl-3.5 pr-3 border-b border-surface-0">
      <span className="flex text-ctp-overlay1"><SearchIcon /></span>
      {modeLabel && (
        <>
          <span data-testid="command-palette-mode" className="text-[13px] text-ctp-overlay1">{modeLabel}</span>
          <span className="text-surface-2" aria-hidden="true">/</span>
        </>
      )}
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        aria-autocomplete="list"
        aria-label="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={PLACEHOLDERS[mode]}
        className="flex-1 min-w-0 bg-transparent text-ctp-text text-[13.5px] outline-none placeholder:text-ctp-overlay0"
        spellCheck={false}
        autoComplete="off"
      />
      <kbd className="text-xs text-ctp-overlay1 border border-surface-1 rounded px-1.5 leading-[18px]">Esc</kbd>
    </div>
  );
}
