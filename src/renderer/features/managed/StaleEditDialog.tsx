import { useMemo } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import type { ManagedPart } from '../../../shared/managed-agents-types';
import { changedLine } from './attribution';
import { lineDiff, partAsText, type PartVersion } from './stale-edit';

/**
 * A part changed after it was opened, in another window or by the Dispatcher
 * over MCP (#2897). Nothing is saved until the person picks: keep theirs,
 * save theirs over with yours (pinned to their revision, so a third change
 * is caught too), or fork.
 */
export function StaleEditDialog({ theirs, mine, busy, error, onClose, onKeepMine, onTakeTheirs, onFork, forkLabel }: {
  theirs: ManagedPart;
  mine: PartVersion;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
  onFork: () => void;
  forkLabel: string;
}) {
  const diff = useMemo(() => lineDiff(partAsText(theirs), partAsText(mine)), [theirs, mine]);
  const same = diff.every((l) => l.kind === 'same');
  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={`${theirs.name} changed since you opened it.`}
      width="w-[640px]"
      testId="managed-stale-dialog"
      footer={(dismiss) => <>
        <Button kind="quiet" className="mr-auto" onClick={onFork} disabled={busy} data-testid="managed-stale-fork">{forkLabel}</Button>
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button onClick={onTakeTheirs} disabled={busy} data-testid="managed-stale-theirs">Take theirs</Button>
        <Button kind="primary" onClick={onKeepMine} disabled={busy} data-testid="managed-stale-mine">Keep mine</Button>
      </>}
    >
      <p className="text-[13px] text-ctp-subtext1" data-testid="managed-stale-by">{changedLine(theirs.updatedAt, theirs.updatedBy)}</p>
      <p className="mt-1 text-xs text-ctp-overlay1">
        {same
          ? 'Their version and yours are the same.'
          : 'Lines only in their version start with a minus sign. Lines only in yours start with a plus sign.'}
      </p>
      <pre
        data-testid="managed-stale-diff"
        aria-label="Their version against yours"
        className="mt-2 max-h-80 overflow-auto px-2.5 py-2 rounded-md border border-surface-0 bg-ctp-mantle font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap break-words"
      >
        {diff.map((l, i) => (
          <div
            key={i}
            data-kind={l.kind}
            className={l.kind === 'theirs' ? 'text-ctp-error' : l.kind === 'yours' ? 'text-ctp-success' : 'text-ctp-subtext0'}
          >
            {l.kind === 'theirs' ? '- ' : l.kind === 'yours' ? '+ ' : '  '}{l.text || ' '}
          </div>
        ))}
      </pre>
      <p className="mt-2 text-xs text-ctp-overlay1">Keep mine saves your version over theirs. Take theirs drops your edit. Cancel returns to your edit. Nothing changes until you pick.</p>
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
