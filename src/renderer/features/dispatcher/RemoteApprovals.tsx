import { useState } from 'react';
import type { MobileGrantAnswer } from '../../../shared/mobile-control';
import { Button } from '../../components/Button';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { useFollowerApprovals, type FollowerApproval } from './leadStore';

/** What each answer is called on its button. */
const ANSWER_LABELS: Record<MobileGrantAnswer, string> = { allow_once: 'Allow once', allow_lasting: 'Allow', decline: 'Decline' };

/** "Laptop: docs-agent wants to push to main." The machine first, in plain words (#3354). */
export function approvalLine(item: FollowerApproval): string {
  return `${item.machineName}: ${item.request.summary}`;
}

/**
 * On the lead (#3354): Ask-first requests from the other computers, in the
 * lead's chat, each with its computer first. A person's click answers one on
 * the computer it came from, which checks it again there; the first answer
 * wins, and the other surface drops it with the next snapshot. Nothing else can
 * answer these: no agent, controller or message reaches the button's path.
 */
export function RemoteApprovals() {
  const items = useFollowerApprovals();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="dispatcher-remote-approvals">
      {items.map((item) => <RemoteApproval key={`${item.machine}:${item.request.requestId}`} item={item} />)}
    </div>
  );
}

function RemoteApproval({ item }: { item: FollowerApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An update's restart choice, and anything newer this computer doesn't know, are answered where they are.
  const answers = item.request.update ? [] : (item.request.answers ?? []).filter((a): a is MobileGrantAnswer => a in ANSWER_LABELS);
  const answer = async (choice: MobileGrantAnswer) => {
    setBusy(true);
    setError(null);
    try {
      await window.clubhouse.dispatcher.answerRemoteApproval(item.machine, item.request.requestId, choice);
    } catch (err) {
      // telemetry-exempt: shown on the row; the request stays as it was there.
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-surface-0 px-3 py-2 text-sm" data-testid="dispatcher-remote-approval" data-machine={item.machine}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0">{approvalLine(item)}</span>
        <span className="flex flex-shrink-0 gap-1.5">
          {answers.length === 0 && <span className="text-xs text-ctp-overlay1">Answer it on {item.machineName}.</span>}
          {answers.map((choice) => (
            <Button key={choice} kind={choice === 'decline' ? 'ghost' : 'primary'} disabled={busy} onClick={() => void answer(choice)} data-testid={`dispatcher-remote-approval-${choice}`}>
              {ANSWER_LABELS[choice]}
            </Button>
          ))}
        </span>
      </div>
      {item.request.allowEffect && <p className="mt-1 text-xs text-ctp-overlay1">{item.request.allowEffect}</p>}
      {error && <p className="mt-1 text-xs text-ctp-error" role="alert" data-testid="dispatcher-remote-approval-error">{error}</p>}
    </div>
  );
}
