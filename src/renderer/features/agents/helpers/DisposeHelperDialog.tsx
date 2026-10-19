/**
 * Disposing one helper (#2232, mockup "Disposing"). The checks from #2241 run
 * as the dialog opens:
 * - clean: Dispose is the main action;
 * - work would be lost: the dialog lists it and offers Dispose anyway;
 * - a check couldn't run: no dispose at all, only Check again.
 * Main does the rest in the dispose_helper tool's order: check, stop the
 * helper if it runs, check again, dispose. If more is at risk after the stop
 * than the user confirmed, nothing is disposed and the dialog shows the new
 * list to confirm again. "Just sleep" stops it and keeps everything.
 *
 * `requestedBy` is for a dispose the orchestrator asked the user to decide
 * (#2251's HELPER_DISPOSE_REQUEST); Cancel then reads Decline and reports it.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Agent, HelperDisposeChecks } from '../../../../shared/types';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { useAgentStore } from '../../../stores/agentStore';
import { checkLines, checksFailed, hasWorkAtRisk } from './helper-model';
import { CheckList } from './CheckList';
import { relativeFolder } from '../details/AgentDetails';

export interface DisposeHelperTarget {
  id: string;
  name: string;
  projectId: string;
  worktreePath?: string;
  /** The rail's status, to stop it first and offer Just sleep. */
  status?: Agent['status'];
}

interface Props {
  helper: DisposeHelperTarget;
  projectPath: string;
  /** The orchestrator that asked, when the request came from it (#2251). */
  requestedBy?: string;
  onClose: () => void;
  onDisposed?: () => void;
  /** The user declined an orchestrator's request (only with `requestedBy`). */
  onDeclined?: () => void;
}

type Phase = 'checking' | 'ready' | 'disposing' | 'sleeping';

export function DisposeHelperDialog({ helper, projectPath, requestedBy, onClose, onDisposed, onDeclined }: Props) {
  const killAgent = useAgentStore((s) => s.killAgent);
  const removeAgent = useAgentStore((s) => s.removeAgent);
  const liveStatus = useAgentStore((s) => s.agents[helper.id]?.status) ?? helper.status;
  const [checks, setChecks] = useState<HelperDisposeChecks | null>(null);
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState<string | null>(null);

  const runChecks = useCallback(async () => {
    setPhase('checking');
    setError(null);
    try {
      setChecks(await window.clubhouse.agent.getDisposeChecks(projectPath, helper.id));
    } catch (err) {
      // telemetry-exempt: shown as a failed check, which blocks disposal.
      setChecks({ dirty: 0, unpushed: 0, unmerged: null, error: err instanceof Error ? err.message : String(err) });
    }
    setPhase('ready');
  }, [projectPath, helper.id]);

  useEffect(() => { void runChecks(); }, [runChecks]);

  const running = liveStatus === 'running';
  const busy = phase === 'disposing' || phase === 'sleeping';
  const failed = !!checks && checksFailed(checks);
  const atRisk = !!checks && !failed && hasWorkAtRisk(checks);
  const folder = relativeFolder(helper.worktreePath, projectPath) ?? helper.worktreePath;

  const close = () => {
    if (busy) return;
    if (requestedBy) onDeclined?.();
    onClose();
  };

  const dispose = async () => {
    if (!checks) return;
    setPhase('disposing');
    setError(null);
    try {
      // Main checks again, stops the helper if it runs, and checks once more
      // before it deletes anything. `checks` is what the user confirmed.
      const result = await window.clubhouse.agent.disposeHelper(projectPath, helper.id, atRisk || undefined, checks);
      if (result.ok) {
        removeAgent(helper.id);
        onDisposed?.();
        onClose();
        return;
      }
      if (result.checks) setChecks(result.checks);
      const stopped = result.stopped ? ` ${helper.name} is stopped and nothing was deleted.` : ' Nothing was deleted.';
      setError(result.changed
        ? `${result.message}. Review what would be lost and confirm again.${result.stopped ? ` ${helper.name} is stopped.` : ''}`
        : `${result.message}.${stopped}`);
    } catch (err) {
      // telemetry-exempt: shown in the dialog.
      setError(err instanceof Error ? err.message : String(err));
    }
    setPhase('ready');
  };

  const justSleep = async () => {
    setPhase('sleeping');
    try {
      await killAgent(helper.id, projectPath);
      if (requestedBy) onDeclined?.();
      onClose();
    } catch (err) {
      // telemetry-exempt: shown in the dialog.
      setError(err instanceof Error ? err.message : String(err));
      setPhase('ready');
    }
  };

  const intro = requestedBy
    ? atRisk
      ? `${requestedBy} asked to dispose of ${helper.name}, but it has work that would be lost.`
      : `${requestedBy} asked to dispose of ${helper.name}.`
    : `This stops ${helper.name}, deletes its folder and its local branch. Anything already pushed stays on the remote.`;

  const footer = (
    <>
      <Button kind="quiet" onClick={close} disabled={busy} data-testid="dispose-cancel">{requestedBy ? 'Decline' : 'Cancel'}</Button>
      {running && !failed && (
        <Button kind="ghost" onClick={() => void justSleep()} disabled={busy || phase === 'checking'} data-testid="dispose-sleep">
          {phase === 'sleeping' ? 'Stopping…' : 'Just sleep'}
        </Button>
      )}
      {failed ? (
        <Button kind="ghost" onClick={() => void runChecks()} disabled={phase === 'checking'} data-testid="dispose-recheck">Check again</Button>
      ) : (
        <Button kind="danger-solid" onClick={() => void dispose()} disabled={busy || phase === 'checking' || !checks} data-testid="dispose-confirm">
          {phase === 'disposing' ? 'Disposing…' : atRisk ? 'Dispose anyway' : 'Dispose'}
        </Button>
      )}
    </>
  );

  return (
    <Modal open onClose={close} title={`Dispose of ${helper.name}?`} width="w-[520px]" testId="dispose-helper-dialog" footer={footer}>
      <div className="flex flex-col gap-2 text-[13px] text-ctp-subtext1 leading-normal">
        <p>{intro}</p>
        {phase === 'checking' || !checks ? (
          <p className="text-xs text-ctp-overlay1" data-testid="dispose-checking">Checking for uncommitted and unpushed work…</p>
        ) : (
          <CheckList lines={checkLines(checks)} testId="dispose-checks" />
        )}
        {failed && (
          <p className="text-xs text-ctp-overlay1" data-testid="dispose-blocked-note">
            Clubhouse can’t dispose of a helper it couldn’t check, even if you’re sure nothing would be lost.
          </p>
        )}
        {atRisk && (
          <p className="text-xs text-ctp-overlay1" data-testid="dispose-risk-note">
            Dispose anyway deletes this work. To keep it, commit and push from {helper.name} first.
          </p>
        )}
        <p className="text-xs text-ctp-overlay1">
          {folder ? <>Deletes <span className="font-mono break-all">{folder}</span> from disk. </> : null}
          {helper.name} stays in the Helpers card as disposed until you remove it.
        </p>
        {error && <p className="text-xs text-ctp-error" role="alert" data-testid="dispose-error">{error}</p>}
      </div>
    </Modal>
  );
}
