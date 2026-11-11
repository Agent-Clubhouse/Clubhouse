/**
 * An action's card (#2953): the whole action, its status line, what to fix,
 * and its recent runs. Run now, Edit, turn on or off, delete.
 */

import { useEffect, useState } from 'react';
import {
  MISSED_RUN_LABELS,
  OVERLAP_LABELS,
  describeStep,
  describeLimits,
  describeTrigger,
  type ActionRun,
  type ActionView,
} from '../../../shared/actions';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { describeRouting } from '../../../shared/helper-routing';
import { openAgent } from '../agents/helpers/orchestration-hooks';
import { settingsError, settingsHelp } from '../settings/SettingsLayout';
import { ownerLabel, useActionNames } from './useActions';

const OUTCOME_WORDS: Record<ActionRun['outcome'], string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Couldn’t run',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

const OUTCOME_DOT: Record<ActionRun['outcome'], string> = {
  running: 'bg-ctp-accent',
  done: 'bg-ctp-green',
  failed: 'bg-ctp-red',
  cancelled: 'bg-surface-2',
  skipped: 'bg-surface-2',
};

export function OutcomeDot({ outcome }: { outcome: ActionRun['outcome'] }) {
  return <span aria-hidden="true" className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${OUTCOME_DOT[outcome]}`} />;
}

export function outcomeWords(outcome: ActionRun['outcome']): string {
  return OUTCOME_WORDS[outcome];
}

export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** The status line: on or off, with the reason Clubhouse turned it off. */
export function statusLine(a: ActionView): string {
  if (!a.enabled) return a.offReason ?? 'Off';
  if (a.running) return 'On, running now';
  return a.nextRunAt ? `On, next run ${formatWhen(a.nextRunAt)}` : 'On';
}

function RunRow({ run }: { run: ActionRun }) {
  const { names, agents } = useActionNames();
  const projectOf = (id: string) => agents.find((a) => a.id === id)?.projectId;
  return (
    <li className="py-2 border-t border-surface-0 text-xs" data-testid="action-run">
      <div className="flex items-center gap-2">
        <OutcomeDot outcome={run.outcome} />
        <span className="text-ctp-text">{outcomeWords(run.outcome)}</span>
        <span className="text-ctp-overlay1">{formatWhen(run.startedAt)}</span>
        {run.endedAt !== undefined && run.endedAt > run.startedAt && (
          <span className="text-ctp-overlay1">took {Math.max(1, Math.round((run.endedAt - run.startedAt) / 1000))}s</span>
        )}
      </div>
      <div className="text-ctp-overlay1 mt-0.5 pl-3.5">
        {run.trigger.kind === 'manual' ? 'Run now' : run.trigger.detail ?? (run.trigger.kind === 'schedule' ? 'On schedule' : 'Triggered')}
        {run.chain.length > 0 && `, set off by ${run.chain.length === 1 ? 'another action' : `${run.chain.length} other actions`}`}
      </div>
      {run.reason && <div className="text-ctp-subtext1 mt-0.5 pl-3.5">{run.reason}</div>}
      {run.steps.length > 0 && (
        <ul className="pl-3.5 mt-0.5">
          {run.steps.map((s, i) => {
            const project = s.agentId ? (s.projectId ?? projectOf(s.agentId)) : undefined;
            return (
              <li key={i} className="text-ctp-overlay1">
                {s.detail}
                {s.routing && <div>Auto chose {s.routing.resolved.provider}. {describeRouting(s.routing)}</div>}
                {s.delivery === 'queued' && (
                  <div>The action fired. The message was queued, not confirmed delivered.</div>
                )}
                {s.agentId && project && (
                  <>
                    {' '}
                    <button type="button" className="text-ctp-accent hover:underline cursor-pointer" onClick={() => openAgent(project, s.agentId!)}>
                      Open {names.agent(s.agentId) ?? 'agent'}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ActionCard({ action, onClose, onEdit }: { action: ActionView; onClose: () => void; onEdit: () => void }) {
  const { names } = useActionNames();
  const [runs, setRuns] = useState<ActionRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let live = true;
    setRuns(null);
    setError(null);
    const load = () => {
      window.clubhouse.actions.history(action.id).then((r) => { if (live) { setRuns(r); setError(null); } }).catch((err: unknown) => {
        // telemetry-exempt: shown on the card
        if (live) setError(ipcErrorMessage(err));
      });
    };
    load();
    const off = window.clubhouse.actions.onChanged(load);
    return () => { live = false; off(); };
  }, [action.id]);

  /** Resolves true when it worked; the error shows on the card otherwise. */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      // telemetry-exempt: shown on the card
      setError(ipcErrorMessage(err));
      return false;
    }
  };

  const t = action.trigger;
  return (
    <Modal
      open
      onClose={onClose}
      title={action.name}
      width="w-[560px]"
      testId="action-card"
      footer={(
        <>
          <Button kind="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>Delete</Button>
          <Button kind="ghost" onClick={() => { void act(() => window.clubhouse.actions.runNow(action.id)); }}>Run now</Button>
          <Button kind="primary" onClick={onEdit}>Edit</Button>
        </>
      )}
    >
      <div className="max-h-[65vh] overflow-y-auto pr-1 text-[13px]">
        <div className="flex items-center gap-3">
          <Toggle checked={action.enabled} aria-label="Action on"
            onChange={(on) => { void act(() => window.clubhouse.actions.setEnabled(action.id, on)); }} />
          <span className="text-ctp-text" data-testid="action-card-status">{statusLine(action)}</span>
        </div>
        {action.problem && (
          <div className="mt-2 text-xs text-ctp-subtext1">
            Last run couldn’t finish: {action.problem} Fix the agent or the step, or edit the action. It stays on, and the next run happens as usual.
          </div>
        )}

        <dl className="mt-4 grid grid-cols-[120px_1fr] gap-y-2 text-xs">
          <dt className="text-ctp-overlay1">When</dt>
          <dd className="text-ctp-text">{describeTrigger(t, names)}</dd>
          {describeLimits(action) && (
            <>
              <dt className="text-ctp-overlay1">Limits</dt>
              <dd className="text-ctp-text">{describeLimits(action)}</dd>
            </>
          )}
          {t.kind === 'schedule' && (
            <>
              <dt className="text-ctp-overlay1">Missed times</dt>
              <dd className="text-ctp-text">{MISSED_RUN_LABELS[t.missed]}</dd>
            </>
          )}
          <dt className="text-ctp-overlay1">Steps</dt>
          <dd className="text-ctp-text">
            <ol className="list-decimal pl-4">
              {action.steps.map((s, i) => (
                <li key={i}>
                  {describeStep(s, names)}
                  {'prompt' in s && s.prompt && <div className="text-ctp-overlay1 whitespace-pre-wrap">{s.prompt}</div>}
                  {'text' in s && s.text && <div className="text-ctp-overlay1 whitespace-pre-wrap">{s.text}</div>}
                </li>
              ))}
            </ol>
          </dd>
          <dt className="text-ctp-overlay1">If still running</dt>
          <dd className="text-ctp-text">{OVERLAP_LABELS[action.overlap]}</dd>
          <dt className="text-ctp-overlay1">Made by</dt>
          <dd className="text-ctp-text">{ownerLabel(action.owner, names)}{action.owner.kind !== 'user' && ', and its usage counts toward it'}</dd>
        </dl>

        <h3 className="text-[13px] font-semibold text-ctp-text mt-5">Recent runs</h3>
        <div className={`${settingsHelp} mb-1`}>The last 10 runs within 72 hours.</div>
        {runs === null && !error && <div className={settingsHelp}>Loading…</div>}
        {runs?.length === 0 && <div className={settingsHelp}>No runs yet.</div>}
        {runs && runs.length > 0 && <ul>{runs.map((r) => <RunRow key={r.id} run={r} />)}</ul>}
        {error && <div role="alert" className={`${settingsError} mt-3`}>{error}</div>}
      </div>
      <ConfirmDestructiveAction
        open={confirmDelete}
        title="Delete this action?"
        description={`“${action.name}” will stop running. Its history goes too.`}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => { setConfirmDelete(false); void act(() => window.clubhouse.actions.delete(action.id)).then((ok) => { if (ok) onClose(); }); }}
      />
    </Modal>
  );
}
