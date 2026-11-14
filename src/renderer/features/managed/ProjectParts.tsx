import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { inputClass } from '../agents/agentSettingsUi';
import {
  PROJECT_PARTS_FOLDER,
  type ManagedPartKind,
  type ManagedPartSummary,
  type ProjectPartItem,
  type ProjectPartReview,
} from '../../../shared/managed-agents-types';
import { errorText, managed, partKindLabel, unwrap, useProjectParts } from './managedApi';
import { DroppedEnvNote } from './parts-ui';
import { lineDiff, partAsText } from './stale-edit';

function stateText(item: ProjectPartItem): string {
  switch (item.state) {
    case 'available': return 'Not in the library yet';
    case 'added': return `In the library as ${item.partName}`;
    case 'changed': return `Changed in the repository since it was added as ${item.partName}`;
    case 'kept': return `Changed in the repository. You kept ${item.partName} as it is`;
    case 'refused': return `Can't be added. ${item.problem ?? ''}`.trim();
  }
}

/**
 * Parts the project's repository offers under `.clubhouse/parts/` for one
 * kind. Nothing here is selected for anyone until the person picks it, and
 * a change in the repository waits for them to review it.
 */
export function ProjectPartsSection({ projectPath, kind, selected, agentName, onUse, disabled }: {
  projectPath: string | undefined;
  kind: ManagedPartKind;
  /** The ids this setup already has. */
  selected: string[];
  agentName?: string;
  /** Select a library part for this agent or draft. */
  onUse?: (part: { id: string; kind: ManagedPartKind }) => void;
  disabled?: boolean;
}) {
  const inventory = useProjectParts(projectPath);
  const [open, setOpen] = useState<ProjectPartItem | null>(null);
  const inv = inventory.value;
  if (!projectPath || !inv) return null;
  const items = inv.items.filter((i) => i.kind === kind);
  const gone = inv.gone.filter((g) => g.key.startsWith(`${kind}:`));
  if (items.length === 0 && gone.length === 0) return null;
  return (
    <section aria-label={`${partKindLabel(kind, true)} from the repository`} className="rounded-lg border border-surface-1 p-2.5" data-testid={`managed-project-parts-${kind}`}>
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-ctp-text">From {inv.projectName}'s repository</h3>
        <span className="text-xs text-ctp-overlay1">{PROJECT_PARTS_FOLDER}</span>
        <Button kind="quiet" className="ml-auto" onClick={inventory.reload} disabled={disabled}>Check again</Button>
      </div>
      <p className="text-xs text-ctp-overlay1 mt-0.5">Clubhouse only reads these files. Nothing in them runs, and none is used until you add it and turn it on.</p>
      <ul className="mt-1.5">
        {items.map((item) => {
          const inUse = !!item.partId && selected.includes(item.partId);
          return (
            <li key={item.key} data-testid="managed-project-part-row" data-key={item.key} data-state={item.state} className="flex items-center gap-2.5 py-1.5 border-t border-surface-0">
              <div className="flex-1 min-w-0">
                <div className="text-[13px] text-ctp-text truncate">{item.name}</div>
                <div className={`text-xs ${item.state === 'changed' ? 'text-ctp-warning' : item.state === 'refused' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>{stateText(item)}</div>
              </div>
              {item.state === 'available' && <Button onClick={() => setOpen(item)} disabled={disabled} aria-label={`Review ${item.name}`}>Review</Button>}
              {(item.state === 'changed' || item.state === 'kept') && <Button onClick={() => setOpen(item)} disabled={disabled} aria-label={`Review the change to ${item.name}`}>Review change</Button>}
              {item.partId && item.state !== 'refused' && onUse && (inUse
                ? <span className="text-xs text-ctp-success">In use</span>
                : <Button onClick={() => onUse({ id: item.partId!, kind })} disabled={disabled} aria-label={`Use ${item.partName ?? item.name}`}>Use</Button>)}
            </li>
          );
        })}
        {gone.map((g) => (
          <li key={g.key} data-testid="managed-project-part-gone" className="py-1.5 border-t border-surface-0">
            <div className="text-[13px] text-ctp-text truncate">{g.partName}</div>
            <div className="text-xs text-ctp-overlay1">No longer in the repository. It stays in the library, and agents that use it keep it.</div>
          </li>
        ))}
      </ul>
      {inv.notes.length > 0 && <ul className="mt-1 text-xs text-ctp-overlay1">{inv.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {open && (
        <ProjectPartDialog
          projectPath={projectPath}
          item={open}
          agentName={agentName}
          onClose={() => setOpen(null)}
          onAdded={(part, use) => { setOpen(null); inventory.reload(); if (use && onUse) onUse({ id: part.id, kind: part.kind }); }}
          canUse={!!onUse}
        />
      )}
    </section>
  );
}

/**
 * Review one repository part before anything changes: its full content for
 * a new one, or the difference from the library's version for a change.
 */
export function ProjectPartDialog({ projectPath, item, agentName, canUse, onClose, onAdded }: {
  projectPath: string;
  item: ProjectPartItem;
  agentName?: string;
  canUse: boolean;
  onClose: () => void;
  onAdded: (part: ManagedPartSummary, use: boolean) => void;
}) {
  const [review, setReview] = useState<ProjectPartReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [reuse, setReuse] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    void unwrap(managed().reviewProjectPart(projectPath, item.key))
      .then((r) => { if (!cancelled) { setReview(r); setName(r.suggestedName); } })
      .catch((err) => { /* telemetry-exempt: shown to the person */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [projectPath, item.key]);
  const change = review?.current;
  const diff = useMemo(() => (review && change
    ? lineDiff(partAsText({ name: change.name, description: '', content: change.content }), partAsText({ name: change.name, description: '', content: review.content }))
    : []), [review, change]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { /* telemetry-exempt: shown to the person */ setError(errorText(err)); } finally { setBusy(false); }
  };
  const hash = review?.item.hash ?? '';
  const add = (use: boolean) => run(async () => {
    const choice = reuse ? { mode: 'reuse' as const, partId: reuse } : { mode: 'copy' as const, name };
    const part = await unwrap(managed().addProjectPart(projectPath, item.key, hash, choice));
    onAdded(part, use);
  });
  const update = () => run(async () => {
    await unwrap(managed().updateProjectPart(projectPath, change!.id, change!.revision, hash));
    onClose();
  });
  const keep = () => run(async () => {
    await unwrap(managed().keepProjectPart(projectPath, change!.id, hash));
    onClose();
  });
  const sameContent = review?.matches.filter((m) => m.sameContent) ?? [];
  const sameName = review?.matches.filter((m) => !m.sameContent) ?? [];
  const title = change ? `${item.name} changed in the repository` : `Add ${item.name} from the repository`;
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={title}
      width="w-[640px]"
      testId="managed-project-part-dialog"
      footer={(dismiss) => change ? <>
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button onClick={() => void keep()} disabled={busy || !review} data-testid="managed-project-part-keep">Keep mine</Button>
        <Button kind="primary" onClick={() => void update()} disabled={busy || !review} data-testid="managed-project-part-update">Update the part</Button>
      </> : <>
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button onClick={() => void add(false)} disabled={busy || !review || (!reuse && !name.trim())} data-testid="managed-project-part-add">{reuse ? 'Use that part' : 'Add to library'}</Button>
        {canUse && (
          <Button kind="primary" onClick={() => void add(true)} disabled={busy || !review || (!reuse && !name.trim())} data-testid="managed-project-part-add-use">
            {`${reuse ? 'Use that part' : 'Add'} for ${agentName ?? 'this agent'}`}
          </Button>
        )}
      </>}
    >
      {!review && !error && <p className="text-[13px] text-ctp-overlay1">Reading the repository.</p>}
      {review && change && (
        <>
          <p className="text-[13px] text-ctp-subtext1">
            {change.usedBy > 0
              ? `${change.name} is used by ${change.usedBy} agent${change.usedBy === 1 ? '' : 's'}. Updating it reaches each one at its next start.`
              : `No agent uses ${change.name} yet.`}
          </p>
          <p className="mt-1 text-xs text-ctp-overlay1">Lines only in the library's version start with a minus sign. Lines only in the repository's copy start with a plus sign.</p>
          <pre data-testid="managed-project-part-diff" aria-label="The library's version against the repository's copy" className="mt-2 max-h-80 overflow-auto px-2.5 py-2 rounded-md border border-surface-0 bg-ctp-mantle font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap break-words">
            {diff.map((l, i) => (
              <div key={i} data-kind={l.kind} className={l.kind === 'theirs' ? 'text-ctp-error' : l.kind === 'yours' ? 'text-ctp-success' : 'text-ctp-subtext0'}>
                {l.kind === 'theirs' ? '- ' : l.kind === 'yours' ? '+ ' : '  '}{l.text || ' '}
              </div>
            ))}
          </pre>
          <p className="mt-2 text-xs text-ctp-overlay1">Keep mine leaves the part as it is until the repository changes again. Nothing changes until you pick.</p>
        </>
      )}
      {review && !change && (
        <>
          <p className="text-[13px] text-ctp-subtext1">This is the repository's copy as it would be added. Read it before adding: Clubhouse didn't run or check anything in it.</p>
          <pre data-testid="managed-project-part-content" className="mt-2 max-h-72 overflow-auto px-2.5 py-2 rounded-md border border-surface-0 bg-ctp-mantle font-mono text-[11.5px] leading-[1.6] text-ctp-text whitespace-pre-wrap break-words">
            {partAsText({ name: review.suggestedName, description: '', content: review.content })}
          </pre>
          <DroppedEnvNote names={review.droppedEnvValues} testId="managed-project-part-dropped-env" className="mt-1" />
          {review.dependencies.length > 0 && (
            <p className="mt-1 text-xs text-ctp-overlay1" data-testid="managed-project-part-dependencies">It says it needs {review.dependencies.join(', ')}. Nothing was installed or checked.</p>
          )}
          {sameContent.length > 0 && (
            <fieldset className="mt-3 text-[13px] text-ctp-text" data-testid="managed-project-part-matches">
              <legend className="text-xs text-ctp-overlay1 mb-1">The library already has the same content.</legend>
              <label className="flex items-center gap-2"><input type="radio" name="project-part-choice" checked={!reuse} onChange={() => setReuse('')} />Add a new part from the repository</label>
              {sameContent.map((m) => (
                <label key={m.id} className="flex items-center gap-2"><input type="radio" name="project-part-choice" checked={reuse === m.id} onChange={() => setReuse(m.id)} />Use {m.name}{m.builtin ? ' (built-in)' : ''}</label>
              ))}
            </fieldset>
          )}
          {sameName.length > 0 && !reuse && (
            <p className="mt-2 text-xs text-ctp-overlay1" data-testid="managed-project-part-name-clash">
              The library has {sameName.map((m) => m.name).join(', ')} with different content. The repository's copy is added beside it under its own name, and doesn't replace it.
            </p>
          )}
          {!reuse && (
            <label className="mt-3 flex flex-col gap-1 text-xs text-ctp-subtext1">
              Library name
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} aria-label="Library name" data-testid="managed-project-part-name" />
            </label>
          )}
          <p className="mt-2 text-xs text-ctp-overlay1">If the repository's copy changes later, Clubhouse shows the difference and asks before it updates the part.</p>
        </>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
