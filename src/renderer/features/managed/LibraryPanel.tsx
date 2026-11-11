import { useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { inputClass, selectClass } from '../agents/agentSettingsUi';
import { CLUBHOUSE_MCP_PART_ID, CLUBHOUSE_PART_NOTE, isListed, type ManagedPartKind, type ManagedPartSummary } from '../../../shared/managed-agents-types';
import { partKindLabel, sourceLabel } from './managedApi';
import { CheckIcon, DroppedEnvNote, PartCatalogStatus } from './parts-ui';
import type { BuilderAgent } from './BlockList';

type SourceFilter = 'all' | 'builtin' | 'custom';

function filterParts(parts: ManagedPartSummary[], query: string, source: SourceFilter): ManagedPartSummary[] {
  const q = query.trim().toLowerCase();
  return parts.filter((p) =>
    (source === 'all' || (source === 'builtin' ? p.builtin : !p.builtin))
    && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
}

function SearchRow({ kind, query, setQuery, source, setSource, inputRef }: {
  kind: ManagedPartKind; query: string; setQuery: (v: string) => void; source: SourceFilter; setSource: (v: SourceFilter) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const label = partKindLabel(kind, true).toLowerCase();
  return (
    <div className="flex gap-1.5">
      <input
        ref={inputRef}
        className={`${inputClass} flex-1 min-w-0`}
        placeholder={`Search ${label}`}
        aria-label={`Search ${label}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <select className={`${selectClass} w-[96px]`} aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
        <option value="all">All</option>
        <option value="builtin">Built-in</option>
        <option value="custom">Custom</option>
      </select>
    </div>
  );
}

/** The block library beside the agent's list: add with one click; blocks already used say so. */
export function LibraryPanel({ parts, error, onRetry, inUse, onAdd, onNew, disabled }: {
  parts: ManagedPartSummary[] | null;
  error?: string | null;
  onRetry?: () => void;
  inUse: string[];
  onAdd: (id: string) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  // A retired built-in (D71) shows only while this setup still uses it.
  const shown = parts ? filterParts(parts.filter((p) => isListed(p) || inUse.includes(p.id)), query, source) : [];
  const addButtons = useRef(new Map<string, HTMLButtonElement>());
  const search = useRef<HTMLInputElement | null>(null);
  if (parts === null || error) {
    return <section aria-label="Instruction block library" data-testid="managed-library-panel"><PartCatalogStatus error={error} onRetry={onRetry} /></section>;
  }
  /** Add, then move focus off the button that goes away: to the next block that can be added, the one before, or the search box. */
  const add = (id: string) => {
    const addable = shown.filter((p) => !inUse.includes(p.id));
    const at = addable.findIndex((p) => p.id === id);
    const next = addable[at + 1] ?? addable[at - 1];
    onAdd(id);
    requestAnimationFrame(() => {
      const target = next ? addButtons.current.get(next.id) : undefined;
      if (target && !target.disabled) target.focus();
      else search.current?.focus();
    });
  };
  return (
    <section aria-label="Instruction block library" className="rounded-lg border border-surface-1 bg-ctp-mantle flex flex-col min-h-0" data-testid="managed-library-panel">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-0">
        <h3 className="text-[13px] font-semibold text-ctp-text">Instruction blocks</h3>
        <Button className="ml-auto" onClick={onNew} disabled={disabled}>New block</Button>
      </div>
      <div className="p-2.5"><SearchRow kind="block" query={query} setQuery={setQuery} source={source} setSource={setSource} inputRef={search} /></div>
      <ul className="overflow-y-auto">
        {shown.map((p) => {
          const used = inUse.includes(p.id);
          return (
            <li key={p.id} className="flex items-start gap-2.5 px-2.5 py-2 border-t border-surface-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 text-[13px]">
                  <span className="text-ctp-text truncate">{p.name}</span>
                  <span className="text-xs text-ctp-overlay1 flex-shrink-0">{p.builtin ? 'Built-in' : 'Custom'}</span>
                </div>
                <div className="text-xs text-ctp-overlay1 line-clamp-2">{p.description || p.preview}</div>
              </div>
              {used ? (
                <span className="flex items-center gap-1 text-xs text-ctp-success pt-0.5 whitespace-nowrap"><CheckIcon />In use</span>
              ) : (
                <Button
                  ref={(el: HTMLButtonElement | null) => { if (el) addButtons.current.set(p.id, el); else addButtons.current.delete(p.id); }}
                  onClick={() => add(p.id)}
                  disabled={disabled}
                  aria-label={`Add ${p.name}`}
                >Add</Button>
              )}
            </li>
          );
        })}
        {shown.length === 0 && <li className="px-2.5 py-3 text-xs text-ctp-overlay1">No blocks match.</li>}
      </ul>
    </section>
  );
}

/** Skills or MCP servers: every part with a switch for this agent. */
export function PartToggleList({ kind, parts, error, onRetry, selected, agent, onToggle, onFork, onEdit, onNew, note, disabled }: {
  kind: 'skill' | 'mcp';
  parts: ManagedPartSummary[] | null;
  error?: string | null;
  onRetry?: () => void;
  selected: string[];
  agent?: BuilderAgent;
  onToggle: (id: string, on: boolean) => void;
  onFork: (id: string) => void;
  onEdit: (id: string) => void;
  onNew: () => void;
  note?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const shown = parts ? filterParts(parts, query, source) : [];
  const label = partKindLabel(kind, true);
  if (parts === null || error) {
    return <section aria-label={label} data-testid={`managed-${kind}-list`}><PartCatalogStatus error={error} onRetry={onRetry} /></section>;
  }
  return (
    <section aria-label={label} className="flex flex-col gap-2" data-testid={`managed-${kind}-list`}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-[320px] max-w-full"><SearchRow kind={kind} query={query} setQuery={setQuery} source={source} setSource={setSource} /></div>
        {note && <span className="text-xs text-ctp-overlay1">{note}</span>}
        <Button className="ml-auto" onClick={onNew} disabled={disabled} data-testid={`managed-${kind}-new`}>{kind === 'skill' ? 'New skill' : 'New MCP server'}</Button>
      </div>
      <ul className="border-t border-surface-0">
        {shown.map((p) => {
          // The Clubhouse MCP part is in every setup: always on, and it can't be turned off or copied.
          const always = kind === 'mcp' && p.id === CLUBHOUSE_MCP_PART_ID;
          const on = always || selected.includes(p.id);
          return (
            <li key={p.id} data-testid="managed-part-row" data-part-id={p.id} className="flex items-center gap-3.5 py-2.5 border-b border-surface-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2.5 text-[13px]">
                  <span className="font-medium text-ctp-text truncate">{p.name}</span>
                  <span className="text-xs text-ctp-overlay1" data-testid="managed-part-source">{sourceLabel(p, agent?.agentId, agent?.agentName)}</span>
                </div>
                {always
                  ? <div className="text-xs text-ctp-overlay1 mt-0.5" data-testid="managed-clubhouse-part-note">{CLUBHOUSE_PART_NOTE}</div>
                  : <div className="text-xs text-ctp-overlay1 mt-0.5 truncate">{p.description || p.preview}</div>}
                <DroppedEnvNote names={p.droppedEnvValues} testId={`managed-part-dropped-env-${p.id}`} className="mt-0.5 truncate" />
              </div>
              <div className="flex items-center gap-1">
                {!p.builtin && <Button kind="quiet" aria-label={`Edit ${p.name}`} onClick={() => onEdit(p.id)} disabled={disabled}>Edit</Button>}
                {!always && <Button kind="quiet" aria-label={p.builtin ? `Make your copy of ${p.name}` : `Fork ${p.name}`} onClick={() => onFork(p.id)} disabled={disabled}>{p.builtin ? 'Make your copy' : 'Fork'}</Button>}
                <Toggle checked={on} onChange={(v) => onToggle(p.id, v)} disabled={disabled || always} aria-label={p.name} data-testid={`managed-part-toggle-${p.id}`} />
              </div>
            </li>
          );
        })}
        {shown.length === 0 && <li className="py-3 text-xs text-ctp-overlay1">{parts.length === 0 ? `No ${label.toLowerCase()} yet.` : 'Nothing matches.'}</li>}
      </ul>
    </section>
  );
}
