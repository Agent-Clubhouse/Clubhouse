import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { textareaClass } from '../agents/agentSettingsUi';
import type { ManagedPart, ManagedPartConsumer, ManagedPartSummary } from '../../../shared/managed-agents-types';
import { ImpactDialog, needsImpactDialog } from './ImpactDialog';
import { errorText, isStale, managed, sourceLabel, unwrap } from './managedApi';
import { noteRunningLeftAlone, restartAfterSave } from './restart';
import { StaleEditDialog } from './StaleEditDialog';
import { GripIcon, WildcardBar } from './parts-ui';

export interface BuilderAgent {
  projectPath: string;
  agentId: string;
  agentName: string;
}

/**
 * The agent's instruction blocks in order (#2895). Drag a block, or focus its
 * handle and use the arrow keys, to reorder. Editing a block edits it for
 * every agent that uses it; Save, Discard and Fork-instead sit in the block.
 */
export function BlockList({ blocks, parts, agent, onChange, onFork, onBackToShared, onWrite, wildcardValues, disabled, notice }: {
  blocks: string[];
  parts: ManagedPartSummary[];
  agent?: BuilderAgent;
  onChange: (blocks: string[]) => void;
  /** Fork a block for this agent: switches it to the copy and returns the copy's id. */
  onFork: (id: string) => Promise<string | undefined>;
  onBackToShared?: (id: string) => Promise<void> | void;
  /** Open the New block dialog for text only this agent uses. */
  onWrite: () => void;
  wildcardValues?: Partial<Record<string, string>>;
  disabled?: boolean;
  /** Said in the list's live region, such as "Identity added." from the library. `seq` makes a repeat count. */
  notice?: { text: string; seq: number };
}) {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [announce, setAnnounce] = useState('');
  const handles = useRef<Array<HTMLButtonElement | null>>([]);
  const writeButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (notice) setAnnounce(notice.text); }, [notice]);

  /** Take a block out, and put focus on the block that took its place, the one before, or Write a block. */
  const remove = (index: number) => {
    const id = blocks[index];
    const next = blocks.filter((b) => b !== id);
    onChange(next);
    setAnnounce(`${byId.get(id)?.name ?? 'Block'} removed.`);
    requestAnimationFrame(() => {
      const target = next.length === 0 ? null : handles.current[Math.min(index, next.length - 1)];
      if (target && !target.disabled) target.focus();
      else writeButton.current?.focus();
    });
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= blocks.length || from === to) return;
    const next = [...blocks];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    onChange(next);
    setAnnounce(`${byId.get(id)?.name ?? 'Block'} moved to position ${to + 1} of ${next.length}.`);
    requestAnimationFrame(() => handles.current[to]?.focus());
  };

  return (
    <div className="flex flex-col gap-2" data-testid="managed-block-list">
      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
      {blocks.length === 0 && (
        <p className="text-[13px] text-ctp-overlay1 py-3" data-testid="managed-blocks-empty">
          Add blocks from the library, or write one for this agent. Identity is a good first block.
        </p>
      )}
      <ol className="flex flex-col gap-2" aria-label="Instruction blocks, in the order the agent reads them">
        {blocks.map((id, index) => {
          const part = byId.get(id);
          return (
            <li
              key={id}
              onDragOver={(e) => { if (dragging !== null) { e.preventDefault(); setOver(index); } }}
              onDrop={(e) => { e.preventDefault(); if (dragging !== null) move(dragging, index); setDragging(null); setOver(null); }}
              className={over === index && dragging !== null && dragging !== index ? 'border-t-2 border-ctp-accent pt-1' : ''}
            >
              <BlockCard
                index={index}
                id={id}
                part={part}
                agent={agent}
                disabled={disabled}
                handleRef={(el) => { handles.current[index] = el; }}
                onDragStart={() => setDragging(index)}
                onDragEnd={() => { setDragging(null); setOver(null); }}
                onMove={(delta) => move(index, index + delta)}
                onRemove={() => remove(index)}
                onFork={() => onFork(id)}
                onBackToShared={onBackToShared && part?.forkedFrom ? () => onBackToShared(id) : undefined}
                wildcardValues={wildcardValues}
              />
            </li>
          );
        })}
      </ol>
      <button
        type="button"
        ref={writeButton}
        onClick={onWrite}
        disabled={disabled}
        data-testid="managed-write-block"
        className="h-8 flex items-center gap-2 px-3 rounded-lg border border-dashed border-surface-1 text-xs text-ctp-subtext0 hover:text-ctp-text hover:border-surface-2 disabled:opacity-50"
      >
        <span aria-hidden>+</span>Write a block for {agent?.agentName ?? 'this agent'}
      </button>
      <p className="text-xs text-ctp-overlay1">Blocks are joined in this order, with a blank line between them. Clubhouse adds nothing else.</p>
    </div>
  );
}

function BlockCard({ index, id, part, agent, disabled, handleRef, onDragStart, onDragEnd, onMove, onRemove, onFork, onBackToShared, wildcardValues }: {
  index: number;
  id: string;
  part: ManagedPartSummary | undefined;
  agent?: BuilderAgent;
  disabled?: boolean;
  handleRef: (el: HTMLButtonElement | null) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onFork: () => Promise<string | undefined>;
  onBackToShared?: () => void;
  wildcardValues?: Partial<Record<string, string>>;
}) {
  const [editing, setEditing] = useState<{ text: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impact, setImpact] = useState<ManagedPartConsumer[] | null>(null);
  // Saving found a newer version (#2897): theirs, and the restarts the person had ticked.
  const [stale, setStale] = useState<{ theirs: ManagedPart; restart: ManagedPartConsumer[] } | null>(null);

  if (!part) {
    return (
      <div className="rounded-lg border border-surface-1 bg-ctp-mantle px-3 py-2 text-xs text-ctp-warning flex items-center gap-2">
        This block no longer exists and is skipped.
        <Button kind="quiet" className="ml-auto" onClick={onRemove} disabled={disabled}>Remove</Button>
      </div>
    );
  }
  const others = part.usedBy.filter((u) => u.agentId !== agent?.agentId);

  const startEdit = async () => {
    setError(null);
    try {
      const full = await unwrap(managed().getPart(id));
      if (full.content.kind === 'block') setEditing({ text: full.content.content, revision: full.revision });
    } catch (err) { /* telemetry-exempt: shown to the person beside the control */ setError(errorText(err)); }
  };
  /** Save the edit. `revision` is theirs when the person chose Keep mine, so a third change is still caught. */
  const save = async (restart: ManagedPartConsumer[] = [], revision = editing?.revision) => {
    if (!editing || revision === undefined) return;
    setBusy(true);
    setError(null);
    let saved: ManagedPartSummary;
    try {
      saved = await unwrap(managed().updatePart({ id, expectedRevision: revision, content: { kind: 'block', content: editing.text } }));
    } catch (err) {
      // telemetry-exempt: a newer version is shown beside this one; anything else beside the control
      if (isStale(err)) {
        try {
          const theirs = await unwrap(managed().getPart(id));
          setImpact(null);
          setStale({ theirs, restart });
          setBusy(false);
          return;
        } catch (readErr) { /* telemetry-exempt: shown beside the control */ setError(errorText(readErr)); setBusy(false); return; }
      }
      setError(errorText(err));
      setBusy(false);
      return;
    }
    // Saved: the editor closes, and restarts run on their own (a working agent waits for its turn to end).
    setEditing(null);
    setImpact(null);
    setStale(null);
    setBusy(false);
    restartAfterSave(restart.map(({ projectPath, agentId, agentName }) => ({ projectPath, agentId, agentName })));
    noteRunningLeftAlone(saved.usedBy, restart);
  };
  const requestSave = () => {
    if (needsImpactDialog(part, others.length)) setImpact(part.usedBy);
    else void save();
  };
  const forkInstead = async () => {
    setImpact(null);
    setStale(null);
    setBusy(true);
    setError(null);
    try {
      const text = editing?.text;
      const copyId = await onFork();
      // The fork failed (the builder says why): keep the editor open with the text.
      if (!copyId) return;
      // The copy now sits where the shared block was: keep the person's edit by applying it there.
      if (text !== undefined && copyId !== id) {
        const copy = await unwrap(managed().getPart(copyId));
        await unwrap(managed().updatePart({ id: copyId, expectedRevision: copy.revision, content: { kind: 'block', content: text } }));
      }
      setEditing(null);
    } catch (err) { /* telemetry-exempt: shown to the person beside the control */ setError(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <div
      data-testid="managed-block"
      data-block-id={id}
      className={`rounded-lg border bg-ctp-mantle px-2 pt-2 pb-2.5 flex flex-col gap-1.5 ${editing ? 'border-ctp-accent' : 'border-surface-1'}`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          ref={handleRef}
          draggable={!disabled && !editing}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); onDragStart(); }}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') { e.preventDefault(); onMove(-1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); onMove(1); }
          }}
          disabled={disabled || !!editing}
          aria-label={`Move ${part.name}. Use the arrow keys.`}
          className="w-5 h-6 grid place-items-center text-ctp-overlay0 cursor-grab rounded focus-visible:outline focus-visible:outline-1 disabled:cursor-default"
        >
          <GripIcon />
        </button>
        <span className="w-4 text-xs text-ctp-overlay0 tabular-nums">{index + 1}</span>
        <span className="text-[13px] font-semibold text-ctp-text truncate">{part.name}</span>
        <span className="text-xs text-ctp-overlay1 truncate" data-testid="managed-block-source">{sourceLabel(part, agent?.agentId, agent?.agentName)}</span>
        <span className="ml-auto flex items-center gap-0.5">
          {!editing && !part.builtin && <Button kind="quiet" aria-label={`Edit ${part.name}`} onClick={() => void startEdit()} disabled={disabled || busy} data-testid="managed-block-edit">Edit</Button>}
          {!editing && (
            <Button kind="quiet" aria-label={part.builtin ? `Make your copy of ${part.name}` : `Fork ${part.name}`} onClick={() => void onFork()} disabled={disabled || busy} data-testid="managed-block-fork">
              {part.builtin ? 'Make your copy' : 'Fork'}
            </Button>
          )}
          {!editing && onBackToShared && <Button kind="quiet" aria-label={`Put ${part.name} back to shared`} onClick={() => void onBackToShared()} disabled={disabled || busy}>Back to shared</Button>}
          {!editing && <Button kind="quiet" aria-label={`Remove ${part.name}`} onClick={onRemove} disabled={disabled || busy}>Remove</Button>}
        </span>
      </div>
      {editing ? (
        <div className="pl-11 flex flex-col gap-2">
          {others.length > 0 && (
            <p className="text-xs text-ctp-subtext1">
              You're editing {part.name} for {part.usedBy.length} agent{part.usedBy.length === 1 ? '' : 's'}.
            </p>
          )}
          <label className="sr-only" htmlFor={`block-edit-${id}`}>{part.name} text</label>
          <textarea
            id={`block-edit-${id}`}
            data-testid="managed-block-text"
            className={`${textareaClass} min-h-28`}
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            disabled={busy}
          />
          <WildcardBar values={wildcardValues} />
          <div className="flex items-center gap-2">
            <Button kind="primary" onClick={requestSave} disabled={busy} data-testid="managed-block-save">
              {part.usedBy.length > 1 ? `Save for ${part.usedBy.length} agents` : 'Save'}
            </Button>
            <Button kind="quiet" onClick={() => { setEditing(null); setError(null); }} disabled={busy}>Discard</Button>
            {others.length > 0 && (
              <Button className="ml-auto" onClick={() => void forkInstead()} disabled={busy}>Fork for {agent?.agentName ?? 'this agent'} instead</Button>
            )}
          </div>
        </div>
      ) : (
        <p className="pl-11 text-xs text-ctp-subtext0 leading-normal line-clamp-2">{part.preview}</p>
      )}
      {error && <p role="alert" className="pl-11 text-xs text-ctp-error">{error}</p>}
      {impact && (
        <ImpactDialog
          open
          partName={part.name}
          consumers={impact}
          busy={busy}
          error={error}
          onCancel={() => setImpact(null)}
          onSave={(restart) => void save(restart)}
          templates={part.templates}
          onForkInstead={() => void forkInstead()}
          forkLabel={`Fork for ${agent?.agentName ?? 'this agent'} instead`}
        />
      )}
      {stale && editing && (
        <StaleEditDialog
          theirs={stale.theirs}
          mine={{ name: stale.theirs.name, description: stale.theirs.description, content: { kind: 'block', content: editing.text } }}
          busy={busy}
          error={error}
          onKeepMine={() => void save(stale.restart, stale.theirs.revision)}
          onTakeTheirs={() => { setStale(null); setEditing(null); setError(null); }}
          onFork={() => void forkInstead()}
          forkLabel={`Fork for ${agent?.agentName ?? 'this agent'}`}
        />
      )}
    </div>
  );
}
