/**
 * An agent's Clubhouse permission requests (#2970), each with Allow and
 * Decline: in the review dialog Needs you opens, and at the top of the
 * agent's permissions page. Main applies the answer, tells the agent, and
 * closes the request, which removes it here.
 */

import { useMemo, useState } from 'react';
import { describeGrantRequest, grantRequestAllowEffect, type GrantRequest } from '../../../shared/grant-requests';
import { Button } from '../../components/Button';
import { reportChromeActionFailed } from '../../chrome/telemetry';
import { grantRequestsFor, useGrantRequestStore } from '../../stores/grantRequestStore';
import { ImportAgentReview, ImportReview } from '../projects/ImportReview';

export function GrantRequestList({ agentId, agentName, onAnswered }: {
  agentId: string;
  agentName: string;
  /** After an answer went through, so a page showing the agent's permissions can reload them. */
  onAnswered?: () => void;
}) {
  const all = useGrantRequestStore((s) => s.requests);
  const requests = useMemo(() => grantRequestsFor(all, agentId), [all, agentId]);
  const remove = useGrantRequestStore((s) => s.remove);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);

  const answer = async (request: GrantRequest, allow: boolean, updateMode?: import('../../../shared/app-update').AppUpdateMode) => {
    setBusy(request.requestId);
    setError(null);
    try {
      const result = updateMode
        ? await window.clubhouse.agent.answerGrantRequest(request.requestId, allow, updateMode)
        : await window.clubhouse.agent.answerGrantRequest(request.requestId, allow);
      if (result.ok === true) {
        remove([request.requestId]);
        onAnswered?.();
      }
      else setError({ id: request.requestId, message: result.error });
    } catch (err) {
      reportChromeActionFailed('agent_settings_save', err);
      setError({ id: request.requestId, message: "Couldn't send your answer. Try again." });
    }
    setBusy(null);
  };

  if (requests.length === 0) return null;
  return (
    <ul className="flex flex-col gap-3" data-testid="grant-request-list" aria-label={`${agentName}'s permission requests`}>
      {requests.map((r) => (
        <li key={r.requestId} className="flex flex-col gap-1.5 text-[13px]" data-testid={`grant-request-${r.requestId}`}>
          <p className="text-ctp-text">{describeGrantRequest(r)}</p>
          {r.reason && <p className="text-ctp-subtext1">Its reason: {r.reason}</p>}
          {r.importReview && <ImportReview plan={r.importReview} />}
          {r.agentReview && <ImportAgentReview review={r.agentReview} />}
          {r.details && (
            <pre className="max-h-40 overflow-auto rounded bg-ctp-mantle p-2 text-xs text-ctp-subtext1 whitespace-pre-wrap break-words">{r.details}</pre>
          )}
          <p className="text-xs text-ctp-overlay1">{grantRequestAllowEffect(r)}</p>
          <div className="flex items-center gap-2">
            {r.update ? <>
              <Button kind="primary" onClick={() => void answer(r, true, 'now')} disabled={busy !== null}>Restart now</Button>
              <Button onClick={() => void answer(r, true, 'when_idle')} disabled={busy !== null}>Restart when idle</Button>
            </> : <Button kind="primary" onClick={() => void answer(r, true)} disabled={busy !== null} data-testid="grant-request-allow">Allow</Button>}
            <Button onClick={() => void answer(r, false)} disabled={busy !== null} data-testid="grant-request-decline">{r.update ? 'Cancel' : 'Decline'}</Button>
          </div>
          {error?.id === r.requestId && <p role="alert" className="text-xs text-ctp-error">{error.message}</p>}
        </li>
      ))}
    </ul>
  );
}
