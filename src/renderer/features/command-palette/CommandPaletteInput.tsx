import { useRef, useEffect } from 'react';
import { useCommandPaletteStore, PaletteMode } from '../../stores/commandPaletteStore';

const MODE_LABELS: Record<PaletteMode, string | null> = {
  all: null,
  commands: 'Commands',
  agents: 'Agents',
  projects: 'Projects',
  hubs: 'Hubs',
};

const MODE_HINTS: { prefix: string; label: string }[] = [
  { prefix: '>', label: 'commands' },
  { prefix: '@', label: 'agents' },
  { prefix: '#', label: 'projects' },
  { prefix: '/', label: 'hubs' },
];

export function CommandPaletteInput() {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = useCommandPaletteStore((s) => s.query);
  const mode = useCommandPaletteStore((s) => s.mode);
  const setQuery = useCommandPaletteStore((s) => s.setQuery);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const modeLabel = MODE_LABELS[mode];

  return (
    <div className="flex flex-col border-b border-surface-0">
      <div className="flex items-center gap-2 px-4 py-3">
        {modeLabel && (
          <span className="text-xs font-medium text-ctp-accent bg-surface-1 px-2 py-0.5 rounded">
            {modeLabel}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type to search..."
          className="flex-1 bg-transparent text-ctp-text text-sm outline-none placeholder:text-ctp-subtext0"
          spellCheck={false}
          autoComplete="off"
        />
        <kbd className="text-xs text-ctp-subtext0 bg-surface-0 px-1.5 py-0.5 rounded">ESC</kbd>
      </div>
      {mode === 'all' && !query && (
        <div className="flex items-center gap-3 px-4 pb-2 text-xs text-ctp-subtext0">
          {MODE_HINTS.map((hint) => (
            <span key={hint.prefix} className="flex items-center gap-1">
              <kbd className="font-mono bg-surface-0 px-1 rounded">{hint.prefix}</kbd>
              <span>{hint.label}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
