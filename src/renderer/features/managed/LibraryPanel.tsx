import { useState } from 'react';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { inputClass, selectClass } from '../agents/agentSettingsUi';
import type { ManagedPartKind, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { partKindLabel, sourceLabel } from './managedApi';
import { CheckIcon } from './parts-ui';
import type { BuilderAgent } from './BlockList';

type SourceFilter = 'all' | 'builtin' | 'custom';

function filterParts(parts: ManagedPartSummary[], query: string, source: SourceFilter): ManagedPartSummary[] {
  const q = query.trim().toLowerCase();
  return parts.filter((p) =>
    (source === 'all' || (source === 'builtin' ? p.builtin : !p.builtin))
    && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
}

function SearchRow({ kind, query, setQuery, source, setSource }: {
  kind: ManagedPartKind; query: string; setQuery: (v: string) => void; source: SourceFilter; setSource: (v: SourceFilter) => void;
}) {
  const label = partKindLabel(kind, true).toLowerCase();
  return (
    <div className="flex gap-1.5">
      <input
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
export function LibraryPanel({ parts, inUse, onAdd, onNew, disabled }: {
  parts: ManagedPartSummary[];
  inUse: string[];
  onAdd: (id: string) => void;
  onNew: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const shown = filterParts(parts, query, source);
  return (
    <section aria-label="Instruction block library" className="rounded-lg border border-surface-1 bg-ctp-mantle flex flex-col min-h-0" data-testid="managed-library-panel">
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-surface-0">
        <h3 className="text-[13px] font-semibold text-ctp-text">Instruction blocks</h3>
        <Button className="ml-auto" onClick={onNew} disabled={disabled}>New block</Button>
      </div>
      <div className="p-2.5"><SearchRow kind="block" query={query} setQuery={setQuery} source={source} setSource={setSource} /></div>
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
                <Button onClick={() => onAdd(p.id)} disabled={disabled} aria-label={`Add ${p.name}`}>Add</Button>
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
export function PartToggleList({ kind, parts, selected, agent, onToggle, onFork, onEdit, onNew, note, disabled }: {
  kind: 'skill' | 'mcp';
  parts: ManagedPartSummary[];
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
  const shown = filterParts(parts, query, source);
  const label = partKindLabel(kind, true);
  return (
    <section aria-label={label} className="flex flex-col gap-2" data-testid={`managed-${kind}-list`}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="w-[320px] max-w-full"><SearchRow kind={kind} query={query} setQuery={setQuery} source={source} setSource={setSource} /></div>
        {note && <span className="text-xs text-ctp-overlay1">{note}</span>}
        <Button className="ml-auto" onClick={onNew} disabled={disabled}>{kind === 'skill' ? 'New skill' : 'New MCP server'}</Button>
      </div>
      <ul className="border-t border-surface-0">
        {shown.map((p) => {
          const on = selected.includes(p.id);
          return (
            <li key={p.id} className="flex items-center gap-3.5 py-2.5 border-b border-surface-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2.5 text-[13px]">
                  <span className="font-medium text-ctp-text truncate">{p.name}</span>
                  <span className="text-xs text-ctp-overlay1">{sourceLabel(p, agent?.agentId, agent?.agentName)}</span>
                </div>
                <div className="text-xs text-ctp-overlay1 mt-0.5 truncate">{p.description || p.preview}</div>
              </div>
              <div className="flex items-center gap-1">
                {!p.builtin && <Button kind="quiet" onClick={() => onEdit(p.id)} disabled={disabled}>Edit</Button>}
                <Button kind="quiet" onClick={() => onFork(p.id)} disabled={disabled}>{p.builtin ? 'Make your copy' : 'Fork'}</Button>
                <Toggle checked={on} onChange={(v) => onToggle(p.id, v)} disabled={disabled} aria-label={`${on ? 'Remove' : 'Add'} ${p.name}`} />
              </div>
            </li>
          );
        })}
        {shown.length === 0 && <li className="py-3 text-xs text-ctp-overlay1">{parts.length === 0 ? `No ${label.toLowerCase()} yet.` : 'Nothing matches.'}</li>}
      </ul>
    </section>
  );
}
