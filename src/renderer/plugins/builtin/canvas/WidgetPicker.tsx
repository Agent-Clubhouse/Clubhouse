import React, { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useWheelContainment } from '../../../hooks/useWheelContainment';
import { useProjectStore } from '../../../stores/projectStore';
import { getAgentColorHex } from '../../../../shared/name-generator';

/**
 * The one picker every canvas card shows before it has a target (#2020):
 * agent, terminal, browser, file viewer and git. A search field, 30px chrome
 * rows, optional section labels, and an optional footer action such as
 * New agent. Replaces six copies that each had an uppercase header and hashed
 * project tiles.
 */

export interface PickerRow {
  id: string;
  label: string;
  /** Leading visuals: a status dot and avatar, a project square, an icon. */
  leading?: ReactNode;
  /** A short right-aligned note, 12px overlay1. */
  meta?: string;
  /** Secondary line under the label, such as a branch. */
  detail?: string;
  /** Muted label, for sleeping agents. */
  muted?: boolean;
  testId?: string;
  onSelect: () => void;
}

export interface PickerSection {
  id: string;
  /** Sentence-case label shown above the rows. Omit for the first section. */
  label?: string;
  rows: PickerRow[];
}

export interface PickerFooter {
  label: string;
  meta?: string;
  testId?: string;
  onSelect: () => void;
}

interface WidgetPickerProps {
  /** Placeholder for the search field, such as "Find an agent". */
  searchPlaceholder: string;
  sections: PickerSection[];
  /** Shown when there are no rows at all. */
  emptyText: string;
  /** A Back row above the search, for two-step pickers. */
  onBack?: () => void;
  backLabel?: string;
  footer?: PickerFooter;
  /** Test id for the scroll region (kept from the old pickers). */
  scrollTestId?: string;
  testId?: string;
}

const SearchIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const PlusIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const BackIcon = (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="15 18 9 12 15 6" />
  </svg>
);

export function WidgetPicker({
  searchPlaceholder,
  sections,
  emptyText,
  onBack,
  backLabel = 'Back',
  footer,
  scrollTestId,
  testId = 'canvas-widget-picker',
}: WidgetPickerProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // #1536: plain wheel scrolling inside the list must never pan the canvas;
  // Ctrl/Cmd+wheel still bubbles so zoom keeps working over the picker.
  const handleWheel = useWheelContainment();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections
      .map((s) => ({ ...s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(q) || r.detail?.toLowerCase().includes(q)) }))
      .filter((s) => s.rows.length > 0);
  }, [sections, query]);

  const flat = useMemo(() => filtered.flatMap((s) => s.rows), [filtered]);
  const total = sections.reduce((n, s) => n + s.rows.length, 0);
  const active = Math.min(highlight, Math.max(flat.length - 1, 0));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length === 0) return;
      const next = (active + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length;
      setHighlight(next);
      listRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      flat[active]?.onSelect();
    }
  };

  let index = -1;
  return (
    <div className="flex flex-col h-full p-2 gap-0.5" data-testid={testId}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="self-start h-7 px-2 -ml-0.5 rounded-md flex items-center gap-1 text-xs text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text transition-colors"
          data-testid="canvas-picker-back"
        >
          {BackIcon}
          {backLabel}
        </button>
      )}
      {total > 0 && (
        <label className="mb-1.5 h-7 px-2 rounded-md border border-surface-1 bg-ctp-base flex items-center gap-1.5 text-ctp-overlay1 focus-within:border-surface-2">
          {SearchIcon}
          <input
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="flex-1 min-w-0 bg-transparent outline-none text-xs text-ctp-text placeholder:text-ctp-overlay1"
            data-testid="canvas-picker-search"
          />
        </label>
      )}
      <div
        ref={listRef}
        role="listbox"
        aria-label={searchPlaceholder}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain flex flex-col gap-0.5"
        onWheel={handleWheel}
        data-testid={scrollTestId}
      >
        {total === 0 ? (
          <div className="px-2.5 py-2 text-xs text-ctp-overlay1">{emptyText}</div>
        ) : flat.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-ctp-overlay1">No matches</div>
        ) : (
          filtered.map((section) => (
            <React.Fragment key={section.id}>
              {section.label && (
                <div className="h-6 flex-shrink-0 flex items-center px-2.5 text-xs text-ctp-overlay1">{section.label}</div>
              )}
              {section.rows.map((row) => {
                index += 1;
                const i = index;
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-row-index={i}
                    onClick={row.onSelect}
                    onMouseEnter={() => setHighlight(i)}
                    className={`flex-shrink-0 w-full min-h-[30px] px-2.5 py-1 rounded-md flex items-center gap-2 text-left transition-colors ${
                      i === active && query ? 'bg-surface-0' : 'hover:bg-surface-0'
                    }`}
                    data-testid={row.testId}
                  >
                    {row.leading}
                    <span className="flex-1 min-w-0">
                      <span className={`block truncate text-[13px] ${row.muted ? 'text-ctp-subtext0' : 'text-ctp-text'}`}>{row.label}</span>
                      {row.detail && <span className="block truncate text-xs text-ctp-overlay1">{row.detail}</span>}
                    </span>
                    {row.meta && <span className="flex-shrink-0 text-xs text-ctp-overlay1">{row.meta}</span>}
                  </button>
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
      {footer && (
        <div className="mt-1 pt-1.5 border-t border-surface-0">
          <button
            type="button"
            onClick={footer.onSelect}
            className="w-full h-[30px] px-2.5 rounded-md flex items-center gap-2 text-[13px] text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text transition-colors"
            data-testid={footer.testId}
          >
            {PlusIcon}
            {footer.label}
            {footer.meta && <span className="ml-auto text-xs text-ctp-overlay1">{footer.meta}</span>}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A project's 16px square, as in the sidebar: its color and first letter.
 * Projects the local store doesn't know (remote ones) get a neutral square.
 */
export function ProjectGlyph({ projectId, name }: { projectId: string; name: string }) {
  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const label = project?.displayName || project?.name || name;
  if (project?.emoji) {
    return <span className="w-4 h-4 rounded flex-shrink-0 flex items-center justify-center text-xs bg-surface-0" aria-hidden="true">{project.emoji}</span>;
  }
  const hex = project ? getAgentColorHex(project.color) : null;
  return (
    <span
      className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center text-xs font-bold leading-none ${hex ? '' : 'bg-surface-0 text-ctp-subtext1'}`}
      style={hex ? { backgroundColor: `${hex}33`, color: hex } : undefined}
      aria-hidden="true"
    >
      {label.charAt(0).toUpperCase()}
    </span>
  );
}

/** Rows for a project list, the first step of most pickers. */
export function projectRows(
  projects: Array<{ id: string; name: string }>,
  onSelect: (projectId: string) => void,
  opts: { testIdPrefix?: string; meta?: (projectId: string) => string | undefined } = {},
): PickerRow[] {
  return projects.map((p) => ({
    id: p.id,
    label: p.name,
    leading: <ProjectGlyph projectId={p.id} name={p.name} />,
    meta: opts.meta?.(p.id),
    testId: opts.testIdPrefix ? `${opts.testIdPrefix}${p.id}` : undefined,
    onSelect: () => onSelect(p.id),
  }));
}
