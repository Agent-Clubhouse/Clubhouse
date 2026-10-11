import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PROJECT_RAIL_MODES, type ProjectRailMode } from '../utils/projectActivity';

const MODE_LABELS: Record<ProjectRailMode, string> = {
  'all': 'All projects',
  'active-first': 'Active first',
  'active-only': 'Active only',
};

function ModeGlyph({ mode, size = 16 }: { mode: ProjectRailMode; size?: number }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  if (mode === 'active-first') {
    // Sort: arrow up beside descending bars
    return (
      <svg {...common}>
        <path d="M7 20V4" /><path d="M3 8l4-4 4 4" />
        <line x1="14" y1="6" x2="21" y2="6" /><line x1="14" y1="12" x2="19" y2="12" /><line x1="14" y1="18" x2="17" y2="18" />
      </svg>
    );
  }
  if (mode === 'active-only') {
    // Filter funnel
    return <svg {...common}><path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" /></svg>;
  }
  // All: plain list
  return (
    <svg {...common}>
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

/**
 * Rail control for choosing how projects are listed: manual order, active
 * projects first, or active projects only. The menu is fixed-positioned but
 * stays a DOM descendant of the rail, so hovering it keeps the rail expanded.
 */
export function ProjectViewMenu({ mode, onChange, expanded }: {
  mode: ProjectRailMode;
  onChange: (mode: ProjectRailMode) => void;
  expanded: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // Read via ref so the open effect focuses the checked item once, on open.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menuWidth = 200;
    setPosition({
      left: Math.min(rect.left, window.innerWidth - menuWidth - 8),
      top: rect.bottom + 4,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const current = PROJECT_RAIL_MODES.indexOf(modeRef.current);
    itemRefs.current[current]?.focus();
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [open, close]);

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => !!el);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  };

  const isFiltered = mode !== 'all';
  const label = MODE_LABELS[mode];

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        title={`Project view: ${label}`}
        aria-label={`Project view: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="rail-view-button"
        data-mode={mode}
        className={`w-full h-7 flex items-center gap-3 cursor-pointer rounded-lg flex-shrink-0 ${
          expanded ? 'hover:bg-surface-0' : ''
        }`}
      >
        <span
          className={`w-10 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors duration-100 ${
            isFiltered ? 'text-ctp-accent' : 'text-ctp-subtext0'
          } ${expanded ? '' : 'hover:bg-surface-1 hover:text-ctp-text'}`}
        >
          <ModeGlyph mode={mode} size={14} />
        </span>
        <span className={`flex-1 min-w-0 flex items-center justify-between pr-3 text-xs text-ctp-subtext0 whitespace-nowrap transition-opacity duration-200 ${expanded ? 'opacity-100' : 'opacity-0'}`}>
          <span className="truncate">{label}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {open && position && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Project view"
          onKeyDown={handleMenuKeyDown}
          className="fixed z-dropdown w-[200px] py-1 rounded-lg shadow-xl border border-surface-1 bg-ctp-mantle"
          style={position}
          data-testid="rail-view-menu"
        >
          {PROJECT_RAIL_MODES.map((m, i) => {
            const checked = m === mode;
            return (
              <button
                key={m}
                ref={(el) => { itemRefs.current[i] = el; }}
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => { onChange(m); close(true); }}
                data-testid={`rail-view-${m}`}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors cursor-pointer outline-none hover:bg-surface-1 focus-visible:bg-surface-1 ${
                  checked ? 'text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'
                }`}
              >
                <ModeGlyph mode={m} size={12} />
                <span className="flex-1 text-left">{MODE_LABELS[m]}</span>
                {checked && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-ctp-accent">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
          {mode !== 'all' && (
            <div className="px-3 pt-1.5 pb-1 mt-1 border-t border-surface-1 text-[11px] text-ctp-overlay0">
              Choose All projects to reorder.
            </div>
          )}
        </div>
      )}
    </>
  );
}
