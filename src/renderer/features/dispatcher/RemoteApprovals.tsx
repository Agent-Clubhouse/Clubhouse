import { useRef, useState } from 'react';
import type { MobileGrantAnswer } from '../../../shared/mobile-control';
import { Button } from '../../components/Button';
import { isRepeatClick } from '../../utils/repeat-click';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { isFollowerApprovalPending, useFollowerApprovals, type FollowerApproval } from './leadStore';
import type { GrantRequest } from '../../../shared/grant-requests';
import { describeGrantRequests } from '../../stores/grantRequestStore';

/** What each answer is called on its button. */
const ANSWER_LABELS: Record<MobileGrantAnswer, string> = { allow_once: 'Allow once', allow_lasting: 'Allow', decline: 'Decline' };

/**
 * "Laptop: docs-agent wants to run git_push, which needs: Push on docs." The
 * computer first, then the agent, then what it asks (#3354).
 */
export function approvalLine(item: FollowerApproval): string {
  const summary = item.request.summary;
  const asks = summary ? summary.charAt(0).toLowerCase() + summary.slice(1) : 'asks for a permission.';
  return `${item.machineName}: ${item.request.agent.name} ${asks}`;
}

/**
 * The lead's Dispatcher row in Needs you: its own requests and the other
 * computers', counted together. Null when there are none.
 */
export function dispatcherNeedsYouLine(local: readonly GrantRequest[], remote: readonly FollowerApproval[]): { message: string; at: number } | null {
  const total = local.length + remote.length;
  if (total === 0) return null;
  const at = Math.min(...local.map((r) => Date.parse(r.createdAt) || 0), ...remote.map((r) => Date.parse(r.request.requestedAt) || 0));
  if (local.length === 0) {
    return { message: `${approvalLine(remote[0])}${remote.length > 1 ? ` (and ${remote.length - 1} more)` : ''}`, at };
  }
  const own = describeGrantRequests(local.slice(0, 1));
  if (remote.length === 0) return { message: describeGrantRequests(local), at };
  return { message: `${own} (${total} requests, ${remote.length} from other computers)`, at };
}

/** The call's arguments as shown, at most this long; the computer it's on has them in full. */
const ARGUMENTS_SHOWN = 4_000;

/**
 * On the lead (#3354): Ask-first requests from the other computers, in the
 * lead's chat, each with its computer first. A person's click answers one on
 * the computer it came from, which checks it again there; the first answer
 * wins, and the other surface drops it with the next snapshot. Nothing else can
 * answer these: no agent, controller or message reaches the button's path.
 *
 * The oldest request shows, with how many wait behind it. Its answers sit at
 * the bottom of the block, above the composer, and its details scroll in a
 * bounded area above them, so the buttons stay where they are as requests
 * come and go (#3606).
 */
export function RemoteApprovals() {
  const items = useFollowerApprovals();
  if (items.length === 0) return null;
  const head = items[0];
  return (
    <div data-testid="dispatcher-remote-approvals">
      <RemoteApproval key={`${head.machine}:${head.request.requestId}`} item={head} waiting={items.length} />
    </div>
  );
}

function RemoteApproval({ item, waiting }: { item: FollowerApproval; waiting: number }) {
  const [busy, setBusy] = useState(false);
  const [answered, setAnswered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // An update's restart choice, and anything newer this computer doesn't know, are answered where they are.
  const answers = item.request.update ? [] : (item.request.answers ?? []).filter((a): a is MobileGrantAnswer => a in ANSWER_LABELS);
  // Set before the first await, so a second activation in the same tick finds it.
  const inFlight = useRef(false);
  const answer = async (choice: MobileGrantAnswer) => {
    // Answers exactly this request: not one that has left its computer's snapshot, and not twice.
    if (inFlight.current || !isFollowerApprovalPending(item.machine, item.request.requestId)) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await window.clubhouse.dispatcher.answerRemoteApproval(item.machine, item.request.requestId, choice);
      // Taken there: no second answer while its next snapshot is on the way.
      setAnswered(true);
    } catch (err) {
      // telemetry-exempt: shown on the row; the request stays as it was there.
      setError(ipcErrorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-surface-0 px-3 py-2 text-sm" data-testid="dispatcher-remote-approval" data-machine={item.machine}>
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 break-words">{approvalLine(item)}</span>
        {waiting > 1 && <span className="flex-shrink-0 text-xs text-ctp-overlay1" data-testid="dispatcher-remote-approval-count">1 of {waiting}</span>}
      </div>
      <div className="flex max-h-[min(24vh,180px)] min-h-0 flex-col gap-1 overflow-y-auto" data-testid="dispatcher-remote-approval-details">
        {item.request.reason && <p className="text-ctp-subtext1">Its reason: {item.request.reason}</p>}
        {item.request.detail && <p className="text-ctp-subtext1">{item.request.detail}</p>}
        {item.request.arguments && (
          <pre className="rounded bg-ctp-mantle p-2 text-xs text-ctp-subtext1 whitespace-pre-wrap break-words" data-testid="dispatcher-remote-approval-arguments">
            {item.request.arguments.length > ARGUMENTS_SHOWN ? `${item.request.arguments.slice(0, ARGUMENTS_SHOWN)}\n… (the rest is on ${item.machineName})` : item.request.arguments}
          </pre>
        )}
        {item.request.allowEffect && <p className="text-xs text-ctp-overlay1">{item.request.allowEffect}</p>}
      </div>
      {error && <p className="text-xs text-ctp-error" role="alert" data-testid="dispatcher-remote-approval-error">{error}</p>}
      <div className="flex min-h-7 items-center justify-end gap-1.5">
        {answered && <span className="text-xs text-ctp-overlay1" role="status" data-testid="dispatcher-remote-approval-answered">Answered.</span>}
        {!answered && answers.length === 0 && <span className="text-xs text-ctp-overlay1">Answer it on {item.machineName}.</span>}
        {!answered && answers.map((choice) => (
          <Button key={choice} kind={choice === 'decline' ? 'ghost' : 'primary'} disabled={busy} onClick={(e) => { if (!isRepeatClick(e)) void answer(choice); }} data-testid={`dispatcher-remote-approval-${choice}`}>
            {ANSWER_LABELS[choice]}
          </Button>
        ))}
      </div>
    </div>
  );
}
