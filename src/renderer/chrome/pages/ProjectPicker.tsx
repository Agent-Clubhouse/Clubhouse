import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../../shared/types';
import { ProjectSquare } from '../sidebar/ProjectGroup';
import { useClickOutside } from '../sidebar/useClickOutside';

/**
 * The New agent page's project control (#2031): a select-like button that opens
 * a listbox with a search field, recent projects, then the rest. With one
 * project there is nothing to pick, so it shows as plain text.
 */

const RECENT = 3;
const ALL_SHOWN = 5;

const ChevronDown = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
const Check = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>
);

const label = (p: Project) => p.displayName || p.name;

interface Props {
  projects: Project[];
  projectIcons: Record<string, string>;
  /** Last activity per project, for the Recent group. */
  activity: Record<string, number>;
  value: string;
  onChange: (projectId: string) => void;
  onAddProject: () => void;
}

export function ProjectPicker({ projects, projectIcons, activity, value, onChange, onAddProject }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpen(false); setQuery(''); }, []);
  useClickOutside(ref, open, close);
  const current = projects.find((p) => p.id === value);

  // Typing searches every project; otherwise Recent, then a few of the rest.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      const hits = projects.filter((p) => label(p).toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
      return { groups: [{ title: 'Projects', items: hits }], more: 0 };
    }
    const recent = [...projects].filter((p) => activity[p.id]).sort((a, b) => activity[b.id] - activity[a.id]).slice(0, RECENT);
    const rest = projects.filter((p) => !recent.includes(p));
    return {
      groups: [
        ...(recent.length > 0 ? [{ title: 'Recent', items: recent }] : []),
        { title: 'All projects', items: rest.slice(0, ALL_SHOWN) },
      ],
      more: Math.max(0, rest.length - ALL_SHOWN),
    };
  }, [projects, activity, query]);
  const flat = useMemo(() => rows.groups.flatMap((g) => g.items), [rows]);
  useEffect(() => setHi(0), [query]);

  if (projects.length === 1 && current) {
    return (
      <span data-testid="new-agent-project" className="h-7 inline-flex items-center gap-2 text-[13px] text-ctp-text">
        <ProjectSquare project={current} iconUrl={projectIcons[current.id]} />
        {label(current)}
        <span className="text-xs text-ctp-overlay1 truncate">{current.path}</span>
      </span>
    );
  }

  const pick = (id: string) => {
    onChange(id);
    close();
    buttonRef.current?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); buttonRef.current?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (flat[hi]) pick(flat[hi].id); }
  };

  return (
    <div ref={ref} className="relative">
      <button
        ref={buttonRef}
        type="button"
        data-testid="new-agent-project"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`w-[340px] max-w-full h-7 px-2 rounded-md border bg-ctp-crust flex items-center gap-2 text-[13px] text-ctp-text cursor-pointer focus-ring ${open ? 'border-ctp-accent' : 'border-surface-1'}`}
      >
        {current && <ProjectSquare project={current} iconUrl={projectIcons[current.id]} />}
        <span className="truncate">{current ? label(current) : 'Choose a project'}</span>
        {current && <span className="text-xs text-ctp-overlay1 truncate">{current.path}</span>}
        <span className="ml-auto flex text-ctp-overlay1">{ChevronDown}</span>
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Project"
          aria-activedescendant={flat[hi] ? `project-option-${flat[hi].id}` : undefined}
          onKeyDown={onKeyDown}
          className="absolute left-0 top-8 z-dropdown w-[340px] p-1 rounded-lg border border-surface-1 bg-ctp-mantle shadow-xl"
        >
          <div className="px-1 pt-1 pb-1.5">
            <input
              autoFocus
              type="text"
              aria-label="Find a project"
              placeholder="Find a project"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full h-7 px-2 rounded-md border border-ctp-accent bg-ctp-crust text-[13px] text-ctp-text placeholder:text-ctp-overlay0 focus-ring"
            />
          </div>
          {rows.groups.map((g) => (
            <div key={g.title} role="group" aria-label={g.title}>
              <div className="h-[26px] px-2.5 flex items-center text-xs font-semibold text-ctp-overlay1">{g.title}</div>
              {g.items.length === 0 && <div className="h-[26px] px-2.5 flex items-center text-xs text-ctp-overlay1">No projects match</div>}
              {g.items.map((p) => {
                const index = flat.indexOf(p);
                return (
                  <div
                    key={p.id}
                    id={`project-option-${p.id}`}
                    role="option"
                    aria-selected={p.id === value}
                    onMouseEnter={() => setHi(index)}
                    onClick={() => pick(p.id)}
                    className={`h-[30px] px-2.5 rounded-md flex items-center gap-2 text-[13px] cursor-pointer ${index === hi ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1'}`}
                  >
                    <ProjectSquare project={p} iconUrl={projectIcons[p.id]} />
                    <span className="whitespace-nowrap">{label(p)}</span>
                    <span className="text-xs text-ctp-overlay1 truncate">{p.path}</span>
                    {p.id === value && <span className="ml-auto flex text-ctp-accent">{Check}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {rows.more > 0 && <div className="h-[26px] px-2.5 flex items-center text-xs text-ctp-overlay1">{rows.more} more, type to find them</div>}
          <div className="h-px bg-surface-0 mx-1.5 my-1" />
          <button
            type="button"
            onClick={() => { close(); onAddProject(); }}
            className="w-full h-[30px] px-2.5 rounded-md flex items-center gap-2 text-[13px] text-ctp-subtext1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
          >
            <span className="w-4 flex justify-center text-ctp-overlay1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            </span>
            Add project…
          </button>
        </div>
      )}
    </div>
  );
}
