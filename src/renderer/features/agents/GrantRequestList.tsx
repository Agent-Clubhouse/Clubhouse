/**
 * An agent's Clubhouse permission requests (#2970), each with Allow and
 * Decline: in the review dialog Needs you opens, and at the top of the
 * agent's permissions page. Main applies the answer, tells the agent, and
 * closes the request, which removes it here.
 */

import { useMemo, useState } from 'react';
import { GRANT_ACTION_LABELS } from '../../../shared/agent-grant-changes';
import type { GrantRequest } from '../../../shared/grant-requests';
import { Button } from '../../components/Button';
import { reportChromeActionFailed } from '../../chrome/telemetry';
import { grantRequestsFor, useGrantRequestStore } from '../../stores/grantRequestStore';

function summary(request: GrantRequest): string {
  const needs = request.actions.map((a) => GRANT_ACTION_LABELS[a] ?? a).join(', ');
  return request.kind === 'call'
    ? `Wants to run ${request.toolName ?? 'a tool'}, which needs: ${needs} on ${request.where}.`
    : `Asks for ${needs} on ${request.where}.`;
}

function outcome(request: GrantRequest): string {
  return request.kind === 'call'
    ? 'Allow runs this one call when it tries again. Its permissions stay as they are.'
    : `Allow adds this to its Clubhouse permissions, where you can remove it later.`;
}

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

  const answer = async (request: GrantRequest, allow: boolean) => {
    setBusy(request.requestId);
    setError(null);
    try {
      const result = await window.clubhouse.agent.answerGrantRequest(request.requestId, allow);
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
          <p className="text-ctp-text">{summary(r)}</p>
          {r.reason && <p className="text-ctp-subtext1">Its reason: {r.reason}</p>}
          {r.details && (
            <pre className="max-h-40 overflow-auto rounded bg-ctp-mantle p-2 text-xs text-ctp-subtext1 whitespace-pre-wrap break-words">{r.details}</pre>
          )}
          <p className="text-xs text-ctp-overlay1">{outcome(r)}</p>
          <div className="flex items-center gap-2">
            <Button kind="primary" onClick={() => void answer(r, true)} disabled={busy !== null} data-testid="grant-request-allow">Allow</Button>
            <Button onClick={() => void answer(r, false)} disabled={busy !== null} data-testid="grant-request-decline">Decline</Button>
          </div>
          {error?.id === r.requestId && <p role="alert" className="text-xs text-ctp-error">{error.message}</p>}
        </li>
      ))}
    </ul>
  );
}
