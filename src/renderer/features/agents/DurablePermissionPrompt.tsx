import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePendingPermissionStore, selectPendingForAgent } from '../../stores/pendingPermissionStore';
import type { PendingPermissionInfo, PermissionResolveRejection } from '../../../shared/permission-types';

/** Human-readable explanation for a refused decision. */
export function explainRejection(reason: PermissionResolveRejection): string {
  switch (reason) {
    case 'expired':
      return 'That request timed out before the decision was sent — the agent will ask again.';
    case 'not_found':
      return 'That request was already answered.';
    case 'agent_mismatch':
      return 'That request belongs to a different agent and was not applied.';
    case 'unknown_agent':
      return 'This agent is no longer running.';
    case 'invalid_decision':
      return 'The decision could not be sent.';
  }
}

/** Seconds left before the queue falls back to 'ask'. */
export function secondsRemaining(permission: PendingPermissionInfo, now: number): number {
  return Math.max(0, Math.ceil((permission.createdAt + permission.timeoutMs - now) / 1000));
}

/** The most useful single line of tool input to show. */
export function primaryInput(permission: PendingPermissionInfo): string | null {
  const input = permission.toolInput;
  if (!input) return null;
  if (typeof input.command === 'string') return input.command;
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.skill === 'string') return input.skill;
  if (typeof input.question === 'string') return input.question;
  const keys = Object.keys(input);
  if (keys.length === 0) return null;
  return JSON.stringify(input, null, 2);
}

interface Props {
  agentId: string;
}

/**
 * Approve/deny prompt for a durable (PTY) agent's pending permission request.
 *
 * Rendered over the agent terminal. Before this existed the desktop could only
 * display a `needs_permission` badge — the decision itself had to come from a
 * connected Annex/iOS client, so unattended agents stalled indefinitely
 * (issue #1553).
 */
export function DurablePermissionPrompt({ agentId }: Props) {
  const byRequestId = usePendingPermissionStore((s) => s.byRequestId);
  const resolve = usePendingPermissionStore((s) => s.resolve);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pending = useMemo(
    () => selectPendingForAgent({ byRequestId }, agentId),
    [byRequestId, agentId],
  );
  const permission = pending[0];

  // Tick the countdown only while a prompt is on screen.
  useEffect(() => {
    if (!permission) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [permission?.requestId]);

  // A new request gets a clean slate.
  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [permission?.requestId]);

  const handleDecision = useCallback(async (decision: 'allow' | 'deny') => {
    if (!permission || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await resolve(agentId, permission.requestId, decision);
      if (outcome.status === 'rejected') setError(explainRejection(outcome.reason));
    } catch {
      setError('Could not reach the agent to send that decision.');
    } finally {
      setBusy(false);
    }
  }, [permission, busy, resolve, agentId]);

  if (!permission) {
    // Surface the tail of a refused decision even after the prompt clears.
    return error ? (
      <div
        className="absolute bottom-2 left-2 right-2 z-20 rounded-lg border border-ctp-surface1 bg-surface-0/95 px-3 py-2 text-xs text-ctp-subtext0 shadow-lg backdrop-blur-sm"
        data-testid="permission-prompt-error"
        role="status"
      >
        {error}
      </div>
    ) : null;
  }

  const remaining = secondsRemaining(permission, now);
  const input = primaryInput(permission);

  return (
    <div
      className="absolute bottom-2 left-2 right-2 z-20 rounded-lg border border-ctp-yellow/40 bg-surface-0/95 shadow-lg backdrop-blur-sm overflow-hidden"
      data-testid="durable-permission-prompt"
      data-request-id={permission.requestId}
      role="alertdialog"
      aria-label="Permission required"
    >
      <div className="px-3 py-2">
        <div className="flex items-center gap-2 mb-1.5">
          <svg className="w-3.5 h-3.5 text-ctp-yellow shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1L1 14h14L8 1z" />
            <line x1="8" y1="6" x2="8" y2="9" />
            <circle cx="8" cy="11.5" r="0.5" fill="currentColor" />
          </svg>
          <span className="text-xs font-medium text-ctp-yellow">Permission required</span>
          <span className="font-mono text-xs text-ctp-text truncate">{permission.toolName}</span>
          <span className="ml-auto text-xs text-ctp-subtext0 tabular-nums shrink-0" data-testid="permission-countdown">
            {remaining}s
          </span>
        </div>

        {permission.message && (
          <p className="text-xs text-ctp-subtext0 mb-1.5 line-clamp-2">{permission.message}</p>
        )}
        {input && (
          <pre className="text-xs text-ctp-subtext1 font-mono bg-ctp-mantle rounded px-2 py-1 mb-1.5 max-h-16 overflow-auto whitespace-pre-wrap break-words">
            {input}
          </pre>
        )}
        {error && (
          <p className="text-xs text-ctp-subtext0 mb-1.5" data-testid="permission-prompt-error">{error}</p>
        )}
        {pending.length > 1 && (
          <p className="text-xs text-ctp-overlay0 mb-1.5" data-testid="permission-queue-count">
            {pending.length - 1} more request{pending.length - 1 === 1 ? '' : 's'} waiting
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            className="px-2.5 py-1 text-xs rounded border border-ctp-surface1 text-ctp-subtext0 hover:bg-surface-1 hover:text-ctp-text transition-colors disabled:opacity-50"
            onClick={() => handleDecision('deny')}
            disabled={busy}
            data-testid="durable-permission-deny"
          >
            Deny
          </button>
          <button
            className="px-2.5 py-1 text-xs rounded bg-ctp-accent text-white hover:bg-ctp-accent/80 transition-colors disabled:opacity-50"
            onClick={() => handleDecision('allow')}
            disabled={busy}
            data-testid="durable-permission-approve"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
