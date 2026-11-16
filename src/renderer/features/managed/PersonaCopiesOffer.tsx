/**
 * Remove duplicate copies (#3579). A block the retired Save to Clubhouse loop
 * filled with copies of a built-in persona is offered for cleanup on the
 * agent's Settings card, one click per block, never on its own. Removal saves
 * a new revision; Undo saves the text before back as the newest revision, and
 * the earlier revision stays in the block's history either way.
 */
import { useState } from 'react';
import type { ManagedPersonaCopies, ManagedPersonaCopiesRemoval } from '../../../shared/managed-agents-types';
import { Button } from '../../components/Button';
import { errorText, managed, unwrap, useManagedPersonaCopies } from './managedApi';

/** "820 bytes", "12 KB". */
export function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);

/** "clever-panda notes repeats the Orchestrator persona 21 times." */
export function repeatsLine(offer: ManagedPersonaCopies): string {
  const list = offer.personas.map((p) => `the ${p.name} persona ${times(p.copies)}`);
  const joined = list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${offer.blockName} repeats ${joined}.`;
}

/** "Removing 20 copies keeps one and saves 124 KB. Your own text in the block stays as it is." */
export function removeLine(offer: ManagedPersonaCopies): string {
  const copies = `${offer.removed} ${offer.removed === 1 ? 'copy' : 'copies'}`;
  const saves = sizeText(offer.bytesSaved);
  const none = offer.personas.filter((p) => p.keep === 'none');
  const what = none.length === 0
    ? `Removing ${copies} keeps one and saves ${saves}.`
    : none.length === offer.personas.length
      ? `Removing all ${copies} saves ${saves}. Every agent using this block already has the built-in ${none.map((p) => p.name).join(' and ')} block.`
      : `Removing ${copies} saves ${saves}.`;
  return `${what} Your own text in the block stays as it is.`;
}

function Offer({ projectPath, agentId, offer, onRemoved }: {
  projectPath: string; agentId: string; offer: ManagedPersonaCopies;
  onRemoved: (removal: ManagedPersonaCopiesRemoval, blockName: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      onRemoved(await unwrap(managed().removePersonaCopies(projectPath, agentId, offer.blockId, offer.revision, offer.removed)), offer.blockName);
    } catch (err) {
      // telemetry-exempt: shown in the card.
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pr-3.5 pl-[33px] pt-1 pb-1.5" data-testid="details-setup-persona-copies">
      <p className="text-xs leading-normal text-ctp-subtext1">{repeatsLine(offer)} {removeLine(offer)}</p>
      <div className="pt-1">
        <Button kind="ghost" onClick={() => void remove()} disabled={busy} data-testid="details-setup-persona-copies-remove">
          {busy ? 'Removing' : 'Remove duplicate copies'}
        </Button>
      </div>
      {error && <p className="text-xs text-ctp-error" role="alert">{error}</p>}
    </div>
  );
}

export function PersonaCopiesOffer({ projectPath, agentId }: { projectPath: string; agentId: string }) {
  const { value: offers } = useManagedPersonaCopies(projectPath, agentId);
  const [done, setDone] = useState<{ removal: ManagedPersonaCopiesRemoval; blockName: string } | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const undo = async () => {
    if (!done) return;
    setUndoing(true);
    setUndoError(null);
    try {
      await unwrap(managed().restorePartRevision(done.removal.blockId, done.removal.fromRevision, done.removal.revision));
      setDone(null);
    } catch (err) {
      // telemetry-exempt: shown in the card.
      setUndoError(errorText(err));
    } finally {
      setUndoing(false);
    }
  };
  return (
    <>
      {(offers ?? []).filter((o) => o.blockId !== done?.removal.blockId).map((offer) => (
        <Offer key={offer.blockId} projectPath={projectPath} agentId={agentId} offer={offer} onRemoved={(removal, blockName) => setDone({ removal, blockName })} />
      ))}
      {done && (
        <div className="pr-3.5 pl-[33px] pt-1 pb-1.5 flex items-center gap-2" data-testid="details-setup-persona-copies-done">
          <span role="status" className="flex-1 min-w-0 text-xs leading-normal text-ctp-subtext1">
            Removed {done.removal.removed} {done.removal.removed === 1 ? 'copy' : 'copies'} from {done.blockName} and saved {sizeText(done.removal.bytesSaved)}. Applies when it restarts or next wakes.
          </span>
          <Button kind="ghost" onClick={() => void undo()} disabled={undoing} data-testid="details-setup-persona-copies-undo">{undoing ? 'Undoing' : 'Undo'}</Button>
        </div>
      )}
      {undoError && <p className="pr-3.5 pl-[33px] text-xs text-ctp-error" role="alert">{undoError}</p>}
    </>
  );
}
