import { useEffect, useRef, useState } from 'react';
import type { ChatHandshakeRetryResult } from '../../../shared/chat';
import { Button } from '../../components/Button';

/** Local-user action only. A result never enables launch or changes settings. */
export function HandshakeRetry({ projectPath, agentId, provider, runtime }: { projectPath: string; agentId: string; provider: string; runtime: string }) {
  const target = JSON.stringify([projectPath, agentId, provider, runtime]);
  const current = useRef(target); current.current = target;
  const sequence = useRef(0);
  const pending = useRef<{ target: string; request: number } | null>(null);
  const [state, setState] = useState<{ target: string; pending: boolean; result?: ChatHandshakeRetryResult }>();
  useEffect(() => () => { sequence.current++; }, [target]);
  const check = async () => {
    if (pending.current?.target === target && pending.current.request === sequence.current) return;
    const request = ++sequence.current;
    pending.current = { target, request };
    setState({ target, pending: true });
    try {
      const result = await window.clubhouse.chat.retryHandshake(projectPath, agentId);
      if (current.current === target && sequence.current === request) setState({ target, pending: false, result });
    } catch (err) {
      // telemetry-exempt: explicit recovery error shown locally, never reported as readiness
      if (current.current === target && sequence.current === request) setState({ target, pending: false, result: { status: 'cannot_probe', message: err instanceof Error ? err.message : 'Could not check this handshake.' } });
    } finally {
      if (pending.current?.request === request) pending.current = null;
    }
  };
  const visible = state?.target === target ? state : undefined;
  return (
    <div className="text-xs text-ctp-subtext1 mt-2">
      <Button kind="ghost" onClick={() => { void check(); }} disabled={visible?.pending}>
        {visible?.pending ? 'Checking handshake…' : 'Retry handshake'}
      </Button>
      <p>Checks the selected chat driver without starting this agent or sending a model request.</p>
      {visible?.result && <p role="status">{visible.result.message}</p>}
    </div>
  );
}
