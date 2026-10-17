import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useHelpSections, resolveHelpSelection } from '../../features/help/useHelpSections';
import { searchHelpTopics, type HelpSearchResult } from '../../features/help/help-search';
import type { HelpSection } from '../../features/help/help-content';

/**
 * Help in the sidebar (#2017, decided 2026-10-17): a search field, then the
 * topic groups as collapsible rows, built-in first and plugins below. Typing
 * replaces the groups with matching topics; the open article stays in the pane.
 */

const Chevron = ({ open }: { open: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const rowClass = (active: boolean, indent: string) =>
  `w-full h-7 ${indent} pr-2 rounded-md flex items-center gap-1.5 text-[13px] text-left cursor-pointer ${
    active ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext1 hover:bg-surface-0/60 hover:text-ctp-text'
  }`;

/** Words from the classic layout that have no topic in the new shell, and where those things went. */
const RETIRED_TERMS: Array<[RegExp, string]> = [
  [/rail|explorer|accessory/i, 'The rails and the accessory panel are gone in this layout. Projects and agents are in the sidebar, and project tabs are in the title bar.'],
  [/dashboard|home/i, 'Home is gone in this layout. Select a project in the sidebar to see its agents and start new ones.'],
];

/** The snippet with each case-insensitive match of the query shown in the primary text color. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<span key={i} className="text-ctp-text">{text.slice(i, i + q.length)}</span>);
    at = i + q.length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

export function HelpNav() {
  const helpSectionId = useUIStore((s) => s.helpSectionId);
  const helpTopicId = useUIStore((s) => s.helpTopicId);
  const query = useUIStore((s) => s.helpSearchQuery);
  const setHelpSection = useUIStore((s) => s.setHelpSection);
  const setHelpTopic = useUIStore((s) => s.setHelpTopic);
  const setQuery = useUIStore((s) => s.setHelpSearchQuery);
  const { builtIn, plugins, all } = useHelpSections();
  const { section: activeSection, topic: activeTopic } = resolveHelpSelection(all, helpSectionId, helpTopicId, true);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeSection ? [activeSection.id] : []));
  // Opening a topic from search expands its group, so it's there when the search is cleared.
  useEffect(() => {
    if (!activeSection) return;
    setExpanded((prev) => (prev.has(activeSection.id) ? prev : new Set(prev).add(activeSection.id)));
  }, [activeSection]);

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? searchHelpTopics(all, query) : []), [all, query, searching]);

  const open = (sectionId: string, topicId: string) => {
    // setHelpSection clears the topic, so the topic goes second.
    if (sectionId !== helpSectionId) setHelpSection(sectionId);
    setHelpTopic(topicId);
  };

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const group = (s: HelpSection) => {
    const isOpen = expanded.has(s.id);
    return (
      <div key={s.id} className="flex flex-col gap-px">
        <button
          type="button"
          aria-expanded={isOpen}
          data-testid={`help-nav-section-${s.id}`}
          onClick={() => toggle(s.id)}
          className={rowClass(false, 'pl-2')}
        >
          <span className="text-ctp-overlay1 flex-shrink-0"><Chevron open={isOpen} /></span>
          <span className="truncate font-medium">{s.title}</span>
          {!isOpen && <span className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">{s.topics.length}</span>}
        </button>
        {isOpen && s.topics.map((t) => {
          const active = activeSection?.id === s.id && activeTopic?.id === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={active ? 'page' : undefined}
              data-testid={`help-nav-topic-${t.id}`}
              onClick={() => open(s.id, t.id)}
              className={rowClass(active, 'pl-[30px]')}
            >
              <span className="truncate">{t.title}</span>
            </button>
          );
        })}
      </div>
    );
  };

  const resultRow = (r: HelpSearchResult) => {
    const active = activeSection?.id === r.sectionId && activeTopic?.id === r.topic.id;
    return (
      <button
        key={`${r.sectionId}:${r.topic.id}`}
        type="button"
        aria-current={active ? 'page' : undefined}
        data-testid={`help-nav-result-${r.topic.id}`}
        onClick={() => open(r.sectionId, r.topic.id)}
        className={`w-full px-2.5 pt-1.5 pb-[7px] rounded-md text-left cursor-pointer ${active ? 'bg-surface-0' : 'hover:bg-surface-0/60'}`}
      >
        <div className="flex items-baseline gap-1.5 text-[13px]">
          <span className={`truncate ${active ? 'text-ctp-text' : 'text-ctp-subtext1'}`}>{r.topic.title}</span>
          <span className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">{r.sectionTitle}</span>
        </div>
        {r.snippet && (
          <div className="mt-0.5 text-xs text-ctp-overlay1 truncate"><Highlighted text={r.snippet} query={query} /></div>
        )}
      </button>
    );
  };

  const retiredHint = RETIRED_TERMS.find(([re]) => re.test(query))?.[1];

  return (
    <div data-testid="help-nav" className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 px-2 pb-2">
        <div className="h-7 px-2 rounded-md bg-surface-0 flex items-center gap-2 text-ctp-overlay1 focus-within:ring-1 focus-within:ring-ctp-accent">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            // Esc clears the search; in an empty field it goes back to Agents, as Esc does elsewhere in the sidebar.
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              if (query) setQuery('');
              else useUIStore.getState().toggleHelp();
            }}
            placeholder="Search help"
            aria-label="Search help"
            data-testid="help-search"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 bg-transparent text-xs text-ctp-text placeholder:text-ctp-overlay1 outline-none"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="flex-shrink-0 hover:text-ctp-text cursor-pointer">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" /></svg>
            </button>
          )}
        </div>
      </div>

      <nav aria-label="Help topics" className="flex-1 min-h-0 overflow-y-auto pb-2 flex flex-col gap-px px-1.5">
        {searching ? (
          results.length > 0 ? (
            <>
              <div className="px-1.5 pb-1 text-xs text-ctp-overlay1">{results.length} {results.length === 1 ? 'topic' : 'topics'}</div>
              {results.map(resultRow)}
            </>
          ) : (
            <div data-testid="help-nav-empty" className="px-3 py-3 text-xs leading-relaxed text-ctp-overlay1">
              <div className="text-ctp-subtext1 mb-1">No topics match &ldquo;{query.trim()}&rdquo;</div>
              {retiredHint ?? 'Try a different word.'}
            </div>
          )
        ) : (
          <>
            {builtIn.map(group)}
            {plugins.length > 0 && (
              <>
                <div className="h-px mx-1.5 my-1.5 bg-surface-0 flex-shrink-0" />
                <div className="px-1.5 pb-1 text-xs font-semibold text-ctp-subtext0">Plugins</div>
                {plugins.map(group)}
              </>
            )}
          </>
        )}
      </nav>
    </div>
  );
}
