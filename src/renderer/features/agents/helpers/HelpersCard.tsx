/**
 * The Helpers card in Agent details (#2232): the orchestrator's direct
 * helpers with their state, branch and unsaved work, and what you can do
 * with each (open, sleep or wake, dispose). Disposed helpers keep their row
 * until removed; they're under "Disposed" at the end, collapsed.
 *
 * Hooks for the orchestration tools:
 * - `approvals` (#2250, in review): approve or decline a helper waiting to
 *   start;
 * - a helper with a `handoff` (#2229) reads as handed off, with a Review
 *   line that opens the dispose dialog.
 * An orchestrator's dispose request (#2229) opens the same dialog from
 * Needs you, through HelperDisposeRequestDialog.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Agent, DurableAgentConfig, HelperDisposeChecks } from '../../../../shared/types';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import { useAgentStore } from '../../../stores/agentStore';
import { useAgentStatuses } from '../agent-status-store';
import { agentDot, StatusDot } from '../agent-status';
import { wakeDurableAgent } from '../wake-durable-agent';
import { CardNote, DetailsCard } from '../details/DetailsCard';
import { HELPER_STATE_LABEL, helperDot, helperState, splitHelpers, workSummary, type HelperState } from './helper-model';
import { openAgent } from './orchestration-hooks';
import { DisposeHelperDialog, type DisposeHelperTarget } from './DisposeHelperDialog';

export interface HelperApprovals {
  onApprove: (helperId: string) => void | Promise<void>;
  onDecline: (helperId: string) => void | Promise<void>;
}

/** The card's one-line answer: live helpers against the limit, and what's starting. */
export function helpersSummary(live: number, maxHelpers: number | undefined, starting: number): string {
  if (live === 0) return 'none';
  const base = maxHelpers ? `${live} of ${maxHelpers}` : String(live);
  return starting > 0 ? `${base} · ${starting} starting` : base;
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const LINK = 'text-xs text-ctp-overlay1 hover:text-ctp-text disabled:opacity-50 cursor-pointer';

export function HelpersCard({ agent, projectPath, configs, maxHelpers, orchestrating, open, onToggle, approvals, onRemoved }: {
  agent: Agent;
  projectPath: string;
  /** Every config in the project (useProjectAgentConfigs), disposed ones included. */
  configs: DurableAgentConfig[];
  maxHelpers?: number;
  orchestrating: boolean;
  open: boolean;
  onToggle: () => void;
  approvals?: HelperApprovals;
  /** A disposed row was removed or a helper disposed: re-read the configs. */
  onRemoved: () => void;
}) {
  const rail = useAgentStore((s) => s.agents);
  const killAgent = useAgentStore((s) => s.killAgent);
  const statuses = useAgentStatuses();
  const { live, disposed } = useMemo(() => splitHelpers(configs, agent.id), [configs, agent.id]);
  const [showDisposed, setShowDisposed] = useState(false);
  const [disposing, setDisposing] = useState<DisposeHelperTarget | null>(null);
  const [removing, setRemoving] = useState<DurableAgentConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const states = useMemo(() => new Map(live.map((h) => [h.id, helperState(h, rail[h.id])] as const)), [live, rail]);
  const starting = [...states.values()].filter((s) => s === 'starting').length;

  // What each helper's folder holds that isn't saved, read while the card is open.
  const checkable = live.filter((h) => { const s = states.get(h.id); return s !== 'starting' && s !== 'failed' && s !== 'awaiting-approval'; });
  const checkKey = checkable.map((h) => `${h.id}:${rail[h.id]?.status ?? ''}`).join(',');
  const [checks, setChecks] = useState<Record<string, HelperDisposeChecks>>({});
  useEffect(() => {
    if (!open || !checkKey) return;
    let alive = true;
    for (const h of checkable) {
      Promise.resolve().then(() => window.clubhouse.agent.getDisposeChecks(projectPath, h.id)).then(
        (c) => { if (alive && c) setChecks((prev) => ({ ...prev, [h.id]: c })); },
        // telemetry-exempt: the row leaves out the unsaved-work line.
        () => {},
      );
    }
    return () => { alive = false; };
    // checkKey stands for `checkable`.
  }, [open, checkKey, projectPath]);

  const sleepOrWake = async (h: DurableAgentConfig, state: HelperState) => {
    setBusy(h.id);
    setError(null);
    try {
      if (state === 'running') await killAgent(h.id, projectPath);
      else await wakeDurableAgent(agent.projectId, projectPath, h.id);
    } catch (err) {
      // telemetry-exempt: shown in the card.
      setError(`Couldn’t ${state === 'running' ? 'stop' : 'wake'} ${h.name}. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (h: DurableAgentConfig) => {
    setRemoving(null);
    setError(null);
    try {
      const result = await window.clubhouse.agent.removeDisposed(projectPath, h.id);
      if (!result.ok) setError(result.message);
    } catch (err) {
      // telemetry-exempt: shown in the card.
      setError(err instanceof Error ? err.message : String(err));
    }
    onRemoved();
  };

  const handedOff = live.filter((h) => states.get(h.id) === 'handed-off');
  const target = (h: DurableAgentConfig): DisposeHelperTarget => ({
    id: h.id, name: h.name, projectId: agent.projectId, worktreePath: h.worktreePath, status: rail[h.id]?.status,
  });

  return (
    <>
      <DetailsCard
        id="helpers"
        title="Helpers"
        summary={helpersSummary(live.length, orchestrating ? maxHelpers : undefined, starting)}
        open={open}
        onToggle={onToggle}
      >
        {live.length === 0 && (
          <CardNote>
            {orchestrating
              ? `No helpers yet. ${agent.name} starts them with its Clubhouse MCP tools.`
              : `Orchestration is off, so ${agent.name} can’t start helpers.`}
          </CardNote>
        )}
        {live.length > 0 && (
          <ul className="flex flex-col" data-testid="helpers-list">
            {live.map((h) => {
              const state = states.get(h.id) ?? 'sleeping';
              const railAgent = rail[h.id];
              const dot = helperDot(state, railAgent ? agentDot(railAgent, statuses[h.id]) : undefined);
              const word = state === 'running' && dot === 'needs' ? 'Needs you' : HELPER_STATE_LABEL[state];
              const work = state === 'failed' ? (railAgent?.errorMessage ?? h.creation?.reason ?? null) : workSummary(checks[h.id]);
              const canRun = state === 'running' || state === 'sleeping' || state === 'handed-off';
              const isRunning = railAgent?.status === 'running';
              return (
                <li key={h.id} className="mx-1 pl-[22px] pr-2.5 py-1 rounded-md hover:bg-surface-0" data-testid={`helper-row-${h.id}`} data-state={state}>
                  <div className="flex items-center gap-2 min-h-[22px]">
                    <StatusDot dot={dot} />
                    <button
                      type="button"
                      onClick={() => openAgent(agent.projectId, h.id)}
                      disabled={!railAgent}
                      className="min-w-0 truncate text-[12.5px] font-medium text-ctp-text hover:underline disabled:no-underline disabled:cursor-default text-left"
                      title={railAgent ? `Open ${h.name}` : undefined}
                      data-testid="helper-open"
                    >
                      {h.name}
                    </button>
                    <span className={`ml-auto flex-shrink-0 text-xs ${state === 'failed' ? 'text-ctp-error' : 'text-ctp-overlay1'}`} data-testid="helper-state">{word}</span>
                  </div>
                  <div className="flex items-center gap-2 min-h-[20px] text-xs text-ctp-overlay1">
                    <span className="min-w-0 truncate">
                      {h.branch && <span className="font-mono text-[11.5px]">{h.branch}</span>}
                      {h.branch && work ? ' · ' : ''}
                      {work && <span data-testid="helper-work">{work}</span>}
                    </span>
                    <span className="ml-auto flex-shrink-0 flex items-center gap-2.5">
                      {state === 'awaiting-approval' && approvals && (
                        <>
                          <button type="button" className={LINK} onClick={() => void approvals.onDecline(h.id)} data-testid="helper-decline">Decline</button>
                          <button type="button" className="text-xs text-ctp-accent hover:underline cursor-pointer" onClick={() => void approvals.onApprove(h.id)} data-testid="helper-approve">Approve</button>
                        </>
                      )}
                      {canRun && railAgent && (
                        <button type="button" className={LINK} disabled={busy === h.id} onClick={() => void sleepOrWake(h, isRunning ? 'running' : 'sleeping')} data-testid="helper-sleep-wake">
                          {isRunning ? 'Sleep' : 'Wake'}
                        </button>
                      )}
                      {state !== 'awaiting-approval' && (
                        <button type="button" className={LINK} onClick={() => setDisposing(target(h))} data-testid="helper-dispose">Dispose</button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {handedOff.length > 0 && (
          <div className="mt-1 mx-1 px-2.5 pl-[22px] pt-1.5 border-t border-surface-0 flex items-center gap-2 text-xs text-ctp-overlay1" data-testid="helpers-ready">
            <span className="min-w-0 truncate">
              {handedOff.length === 1 ? `${handedOff[0].name} is handed off and ready to dispose` : `${handedOff.length} helpers are handed off and ready to dispose`}
            </span>
            <button type="button" className="ml-auto text-ctp-accent hover:underline cursor-pointer" onClick={() => setDisposing(target(handedOff[0]))}>Review</button>
          </div>
        )}
        {disposed.length > 0 && (
          <div className="mt-1 mx-1 border-t border-surface-0 pt-0.5">
            <button
              type="button"
              onClick={() => setShowDisposed((v) => !v)}
              aria-expanded={showDisposed}
              className="w-full h-[26px] flex items-center gap-[7px] px-2.5 rounded-md text-left text-xs text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text"
              data-testid="helpers-disposed-toggle"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0 text-ctp-overlay0">
                <path d={showDisposed ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
              </svg>
              Disposed <span className="text-ctp-overlay0">{disposed.length}</span>
            </button>
            {showDisposed && (
              <ul className="flex flex-col" data-testid="helpers-disposed">
                {disposed.map((h) => (
                  <li key={h.id} className="h-[26px] flex items-center gap-2 pl-[22px] pr-2.5 text-xs" data-testid={`disposed-row-${h.id}`}>
                    <span className="min-w-0 truncate text-ctp-subtext1">{h.name}</span>
                    <span className="text-ctp-overlay1 whitespace-nowrap">{formatWhen(h.disposedAt)}</span>
                    <button type="button" className={`ml-auto ${LINK}`} onClick={() => setRemoving(h)} data-testid="disposed-remove">Remove</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="pr-3.5 pl-[33px] pt-1 pb-1.5 text-xs text-ctp-error" role="alert" data-testid="helpers-error">{error}</p>}
      </DetailsCard>
      {disposing && (
        <DisposeHelperDialog
          helper={disposing}
          projectPath={projectPath}
          onClose={() => setDisposing(null)}
          onDisposed={onRemoved}
        />
      )}
      <ConfirmDestructiveAction
        open={removing !== null}
        title={`Remove ${removing?.name ?? ''} for good?`}
        description={`Its folder is already gone. This removes ${removing?.name ?? 'it'} and its session list from Clubhouse. It can’t be undone.`}
        confirmLabel="Remove"
        onCancel={() => setRemoving(null)}
        onConfirm={() => { if (removing) void remove(removing); }}
      />
    </>
  );
}
