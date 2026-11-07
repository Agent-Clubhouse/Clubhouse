import { useEffect, useMemo, useState } from 'react';
import type { ManagedPart, ManagedPartKind, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { formatAgo } from '../agents/states/format';
import { SettingsPage, settingsError, settingsHelp, settingsInput } from '../settings/SettingsLayout';
import { PartDialog } from './PartDialog';
import { errorText, managed, partKindLabel, unwrap, useManagedParts } from './managedApi';
import { AgentDot, DroppedEnvNote } from './parts-ui';

type SourceFilter = 'all' | 'builtin' | 'custom';

/** A custom part only one agent uses and no template lists: usually a fork made for that agent. */
export function usedByOneAgent(p: ManagedPartSummary): boolean {
  return !p.builtin && p.usedBy.length === 1 && p.templates.length === 0;
}

const GRID = 'grid grid-cols-[minmax(0,1fr)_minmax(0,140px)_minmax(0,140px)] gap-x-4 items-center';

function updatedText(p: ManagedPartSummary): string {
  const t = Date.parse(p.updatedAt);
  const when = Number.isFinite(t) ? formatAgo(t) : '';
  if (!p.updatedBy) return when;
  return when ? `${when} by ${p.updatedBy}` : `by ${p.updatedBy}`;
}

function UsedBy({ part }: { part: ManagedPartSummary }) {
  const n = part.usedBy.length;
  if (n === 0) return <span className="text-xs text-ctp-overlay1">No agents</span>;
  return (
    <span className="flex items-center gap-1.5 min-w-0" aria-label={`Used by ${n} agent${n === 1 ? '' : 's'}`}>
      <span className="flex items-center -space-x-1 flex-shrink-0">
        {part.usedBy.slice(0, 3).map((u) => (
          <span key={`${u.projectPath}:${u.agentId}`} className="rounded-full ring-2 ring-ctp-base"><AgentDot name={u.agentName} color={u.color} /></span>
        ))}
      </span>
      <span className="text-xs text-ctp-subtext1 truncate">{n}</span>
    </span>
  );
}

/** The part's text, files or command, loaded when its row opens. */
function PartContent({ id, revision }: { id: string; revision: number }) {
  const [part, setPart] = useState<ManagedPart | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void unwrap(managed().getPart(id))
      .then((p) => { if (!cancelled) { setPart(p); setError(null); } })
      .catch((err) => { /* telemetry-exempt: shown in the detail panel */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [id, revision]);
  if (error) return <p role="alert" className={settingsError}>{error}</p>;
  if (!part) return <p className={settingsHelp}>Loading…</p>;
  const c = part.content;
  if (c.kind === 'block') {
    return (
      <pre data-testid="managed-part-text" className="max-h-64 overflow-auto px-2.5 py-2 rounded-md border border-surface-0 bg-ctp-mantle font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap break-words">
        {c.content || 'No text.'}
      </pre>
    );
  }
  if (c.kind === 'skill') {
    return (
      <div className="flex flex-col gap-1">
        <p className={settingsHelp}>Folder <span className="font-mono text-ctp-subtext1">{c.skillName}</span></p>
        <ul data-testid="managed-part-files" className="rounded-md border border-surface-0">
          {c.files.map((f) => (
            <li key={f.path} className="flex items-center gap-2 px-2.5 py-1.5 border-b border-surface-0 last:border-b-0 min-w-0">
              <span className="font-mono text-xs text-ctp-text truncate">{f.path}</span>
              <span className="ml-auto flex-shrink-0 text-xs text-ctp-overlay1">
                {[f.encoding === 'base64' ? 'binary' : null, f.executable ? 'executable' : null].filter(Boolean).join(', ')}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <dl data-testid="managed-part-mcp" className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-ctp-overlay1">Server key</dt><dd className="font-mono text-ctp-text truncate">{c.serverKey}</dd>
      {c.transport === 'stdio' ? (
        <>
          <dt className="text-ctp-overlay1">Command</dt>
          <dd className="font-mono text-ctp-text break-words">{[c.command, ...(c.args ?? [])].filter(Boolean).join(' ')}</dd>
        </>
      ) : (
        <><dt className="text-ctp-overlay1">URL</dt><dd className="font-mono text-ctp-text break-words">{c.url}</dd></>
      )}
      {(c.envVars?.length ?? 0) > 0 && <><dt className="text-ctp-overlay1">Environment</dt><dd className="font-mono text-ctp-text break-words">{c.envVars!.join(', ')}</dd></>}
    </dl>
  );
}

function PartDetail({ part, onEdit, onFork, onDelete }: {
  part: ManagedPartSummary;
  onEdit: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(part.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!renaming) setName(part.name); }, [part.name, renaming]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === part.name) { setRenaming(false); return; }
    setBusy(true);
    setError(null);
    try {
      await unwrap(managed().updatePart({ id: part.id, expectedRevision: part.revision, name: next }));
      setRenaming(false);
    } catch (err) {
      // telemetry-exempt: shown in the detail panel.
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="managed-part-detail" className="flex flex-col gap-3 px-3 pt-1 pb-3">
      {part.description && <p className="text-xs text-ctp-subtext0">{part.description}</p>}
      {renaming ? (
        <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); void rename(); }}>
          <input className={`${settingsInput} w-[260px] max-w-full`} aria-label="New name" value={name} onChange={(e) => setName(e.target.value)} autoFocus disabled={busy} />
          <Button kind="primary" type="submit" disabled={busy || !name.trim()}>Rename</Button>
          <Button kind="quiet" onClick={() => { setRenaming(false); setError(null); }} disabled={busy}>Cancel</Button>
          <span className={`${settingsHelp} min-w-0 truncate`}>Renames it everywhere it is used.</span>
        </form>
      ) : (
        <div className="flex items-center gap-1 flex-wrap">
          {!part.builtin && <Button aria-label={`Edit ${part.name}`} onClick={onEdit}>Edit</Button>}
          <Button aria-label={part.builtin ? `Make your copy of ${part.name}` : `Fork ${part.name}`} onClick={onFork}>{part.builtin ? 'Make your copy' : 'Fork'}</Button>
          {!part.builtin && <Button kind="quiet" aria-label={`Rename ${part.name}`} onClick={() => setRenaming(true)}>Rename</Button>}
          {!part.builtin && <Button kind="danger" aria-label={`Delete ${part.name}`} onClick={onDelete}>Delete</Button>}
          {part.builtin && <span className={`${settingsHelp} ml-1`}>Built-in parts are read-only and update with Clubhouse.</span>}
        </div>
      )}
      {error && <p role="alert" className={settingsError}>{error}</p>}
      <PartContent id={part.id} revision={part.revision} />
      <DroppedEnvNote names={part.droppedEnvValues} testId="managed-part-dropped-env" />
      <div>
        <h4 className="text-xs font-medium text-ctp-subtext1 mb-1">Used by</h4>
        {part.usedBy.length === 0 && part.templates.length === 0 ? (
          <p className={settingsHelp}>No agent or template uses it.</p>
        ) : (
          <ul data-testid="managed-part-consumers" className="flex flex-col">
            {part.usedBy.map((u) => (
              <li key={`${u.projectPath}:${u.agentId}`} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 items-center py-1.5 border-t border-surface-0 text-[13px]">
                <AgentDot name={u.agentName} color={u.color} />
                <span className="min-w-0 truncate"><span className="text-ctp-text">{u.agentName}</span> <span className="text-xs text-ctp-overlay1">{u.projectName}</span></span>
                <span className="flex items-center gap-1.5 text-xs text-ctp-overlay1">
                  <span aria-hidden className={`w-2 h-2 rounded-full ${u.running ? 'bg-ctp-success' : 'border border-ctp-overlay0'}`} />
                  {u.running ? 'Running' : 'Sleeping'}
                </span>
              </li>
            ))}
            {part.templates.map((t) => (
              <li key={`template:${t.id}`} className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-x-2.5 items-center py-1.5 border-t border-surface-0 text-[13px]">
                <span aria-hidden />
                <span className="min-w-0 truncate text-ctp-text">{t.name}</span>
                <span className="text-xs text-ctp-overlay1">Template</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Deleting a custom part: agents that use it keep a copy, or lose it at their next start. */
export function DeletePartDialog({ part, onClose }: { part: ManagedPartSummary; onClose: (deleted: boolean) => void }) {
  const [mode, setMode] = useState<'copy' | 'remove'>('copy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inUse = part.usedBy.length > 0;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(managed().deletePart(part.id, part.revision, inUse ? mode : 'remove'));
      onClose(true);
    } catch (err) {
      // telemetry-exempt: shown in the dialog.
      setError(errorText(err));
      setBusy(false);
    }
  };
  const n = part.usedBy.length;
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={`Delete ${part.name}?`}
      width="w-[520px]"
      testId="managed-delete-dialog"
      footer={<>
        <Button onClick={() => onClose(false)} disabled={busy}>Cancel</Button>
        <Button kind="danger-solid" onClick={() => void confirm()} disabled={busy} data-testid="managed-delete-confirm">Delete</Button>
      </>}
    >
      <div className="flex flex-col gap-3 text-[13px] text-ctp-subtext1">
        {inUse ? (
          <>
            <p>{n} agent{n === 1 ? ' uses' : 's use'} it.</p>
            <ul className="flex flex-col">
              {part.usedBy.map((u) => (
                <li key={`${u.projectPath}:${u.agentId}`} className="flex items-center gap-2 py-1 min-w-0">
                  <AgentDot name={u.agentName} color={u.color} />
                  <span className="text-ctp-text truncate">{u.agentName}</span>
                  <span className="text-xs text-ctp-overlay1 truncate">{u.projectName}</span>
                </li>
              ))}
            </ul>
            <fieldset className="flex flex-col gap-2">
              <legend className="sr-only">What happens to those agents</legend>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="managed-delete-mode" className="mt-0.5" checked={mode === 'copy'} onChange={() => setMode('copy')} />
                <span><span className="text-ctp-text">Give each agent its own copy</span><span className="block text-xs text-ctp-overlay1">They keep what it says now.</span></span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input type="radio" name="managed-delete-mode" className="mt-0.5" checked={mode === 'remove'} onChange={() => setMode('remove')} />
                <span><span className="text-ctp-text">Remove it from those agents</span><span className="block text-xs text-ctp-overlay1">It's gone at their next start.</span></span>
              </label>
            </fieldset>
          </>
        ) : (
          <p>No agent uses it. It's removed from the library.</p>
        )}
        {part.templates.length > 0 && (
          <p className="text-xs text-ctp-overlay1">Templates that list it drop it: {part.templates.map((t) => t.name).join(', ')}.</p>
        )}
        {error && <p role="alert" className={settingsError}>{error}</p>}
      </div>
    </Modal>
  );
}

/**
 * Settings, Managed agents, Agent parts (#2894): every instruction block,
 * skill or MCP server in the library, who uses it, and what it holds.
 */
export function PartLibraryView({ kind }: { kind: ManagedPartKind }) {
  const { value: parts, error } = useManagedParts(kind);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [showSingle, setShowSingle] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ editId?: string } | null>(null);
  const [deleting, setDeleting] = useState<ManagedPartSummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const plural = partKindLabel(kind, true);
  const singular = partKindLabel(kind).toLowerCase();

  const { shown, hidden } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matching = (parts ?? []).filter((p) =>
      (source === 'all' || (source === 'builtin' ? p.builtin : !p.builtin))
      && (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
    const single = matching.filter(usedByOneAgent);
    return { shown: showSingle ? matching : matching.filter((p) => !usedByOneAgent(p)), hidden: showSingle ? 0 : single.length };
  }, [parts, query, source, showSingle]);

  const fork = async (p: ManagedPartSummary) => {
    setActionError(null);
    try {
      const copy = await unwrap(managed().forkPart(p.id));
      setSelected(copy.id);
    } catch (err) {
      // telemetry-exempt: shown above the list.
      setActionError(errorText(err));
    }
  };

  return (
    <SettingsPage
      title={plural}
      description="Agent parts your agents use. Built-in parts update with Clubhouse."
      actions={<Button kind="primary" onClick={() => setDialog({})} data-testid="managed-library-new">New {singular}</Button>}
      testId={`managed-library-${kind}`}
    >
      <div className="flex items-center gap-2 flex-wrap mt-4 mb-2">
        <input
          className={`${settingsInput} w-[220px] max-w-full`}
          placeholder={`Search ${plural.toLowerCase()}`}
          aria-label={`Search ${plural.toLowerCase()}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={`${settingsInput} w-[110px]`} aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as SourceFilter)}>
          <option value="all">All</option>
          <option value="builtin">Built-in</option>
          <option value="custom">Custom</option>
        </select>
        <label className="ml-auto flex items-center gap-2 text-xs text-ctp-subtext1 cursor-pointer">
          <Toggle checked={showSingle} onChange={setShowSingle} aria-label="Show parts used by one agent" data-testid="managed-library-show-single" />
          Show parts used by one agent
          {hidden > 0 && <span className="text-ctp-overlay1" data-testid="managed-library-hidden">{hidden} hidden</span>}
        </label>
      </div>
      {(error || actionError) && <p role="alert" className={`${settingsError} mb-2`}>{error ?? actionError}</p>}
      <div className={`${GRID} px-3 pb-1 text-xs text-ctp-overlay1`} aria-hidden>
        <span>Name</span><span>Used by</span><span>Updated</span>
      </div>
      <ul className="border-t border-surface-0" data-testid="managed-library-rows">
        {parts === null && !error && <li className={`${settingsHelp} px-3 py-3`}>Loading…</li>}
        {shown.map((p) => {
          const open = selected === p.id;
          return (
            <li key={p.id} className={`border-b border-surface-0 ${open ? 'bg-ctp-mantle' : ''}`} data-testid="managed-library-row">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setSelected(open ? null : p.id)}
                className={`${GRID} w-full px-3 py-2 text-left cursor-pointer hover:bg-surface-0/60`}
              >
                <span className="min-w-0">
                  <span className="block text-[13px] text-ctp-text truncate">{p.name}</span>
                  <span className="block text-xs text-ctp-overlay1 truncate">{p.builtin ? 'Built-in' : 'Custom'}{p.description ? ` · ${p.description}` : ''}</span>
                </span>
                <UsedBy part={p} />
                <span className="text-xs text-ctp-overlay1 truncate">{updatedText(p)}</span>
              </button>
              {open && (
                <PartDetail
                  part={p}
                  onEdit={() => setDialog({ editId: p.id })}
                  onFork={() => void fork(p)}
                  onDelete={() => setDeleting(p)}
                />
              )}
            </li>
          );
        })}
        {parts !== null && shown.length === 0 && (
          <li className={`${settingsHelp} px-3 py-3`}>
            {parts.length === 0 ? `No ${plural.toLowerCase()} yet.` : hidden > 0 ? 'Only parts used by one agent match. Turn on the switch above to see them.' : 'Nothing matches.'}
          </li>
        )}
      </ul>
      {dialog && (
        <PartDialog
          open
          kind={kind}
          editId={dialog.editId}
          onClose={() => setDialog(null)}
          onCreated={(part) => setSelected(part.id)}
        />
      )}
      {deleting && (
        <DeletePartDialog part={deleting} onClose={(deleted) => { if (deleted && selected === deleting.id) setSelected(null); setDeleting(null); }} />
      )}
    </SettingsPage>
  );
}
