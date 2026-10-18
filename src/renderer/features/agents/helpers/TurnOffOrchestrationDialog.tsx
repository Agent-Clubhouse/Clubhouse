/**
 * Turning orchestration off while the agent has helpers (#2232, decided 18
 * October): keep them as normal agents, dispose them, or cancel. Disposing
 * runs #2241's checks for every helper first. When work would be lost the
 * dialog lists it and offers "Dispose anyway"; a helper whose checks couldn't
 * run can never be forced, so then only Keep and Cancel remain.
 */

import { useEffect, useState } from 'react';
import type { Agent, DurableAgentConfig, HelperDisposeBlock } from '../../../../shared/types';
import type { OrchestrationOffChoice, ResolvedOrchestrationPolicy, TurnOffOrchestrationResult } from '../../../../shared/orchestration-policy';
import { Modal } from '../../../components/Modal';
import { Button } from '../../../components/Button';
import { useAgentStore } from '../../../stores/agentStore';
import { HELPER_STATE_LABEL, checkLines, helperState, plural } from './helper-model';
import { reloadProjectAgents } from './orchestration-hooks';
import { CheckList } from './CheckList';

interface Props {
  agent: Pick<Agent, 'id' | 'name' | 'projectId'>;
  projectPath: string;
  helperIds: string[];
  /** Closed: `policy` is set when orchestration went off. */
  onDone: (policy?: ResolvedOrchestrationPolicy) => void;
}

type Phase =
  | { kind: 'choose' }
  | { kind: 'working'; choice: OrchestrationOffChoice; force: boolean }
  | { kind: 'blocked'; blocked: HelperDisposeBlock[]; message: string }
  | { kind: 'failed'; message: string }
  /** Orchestration went off, but some helpers couldn't be settled. */
  | { kind: 'partial'; policy: ResolvedOrchestrationPolicy; message: string };

export function TurnOffOrchestrationDialog({ agent, projectPath, helperIds, onDone }: Props) {
  const rail = useAgentStore((s) => s.agents);
  const [helpers, setHelpers] = useState<DurableAgentConfig[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'choose' });

  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.listDurable(projectPath)).then(
      (list: DurableAgentConfig[]) => { if (alive) setHelpers((list ?? []).filter((c) => helperIds.includes(c.id))); },
      // telemetry-exempt: the dialog still works with the count alone.
      () => { if (alive) setHelpers([]); },
    );
    return () => { alive = false; };
  }, [projectPath, helperIds]);

  const working = phase.kind === 'working';
  const count = helperIds.length;

  const cancel = () => {
    if (working) return;
    if (phase.kind === 'partial') { onDone(phase.policy); return; }
    // Nothing changes on cancel; main is told so it can drop anything held for the choice.
    void Promise.resolve().then(() => window.clubhouse.agent.turnOffOrchestration(projectPath, agent.id, 'cancel')).catch(() => {
      // telemetry-exempt: cancelling changes nothing, so a failed call has nothing to undo.
    });
    onDone();
  };

  const run = async (choice: 'keep' | 'dispose', force = false) => {
    setPhase({ kind: 'working', choice, force });
    let result: TurnOffOrchestrationResult;
    try {
      result = await window.clubhouse.agent.turnOffOrchestration(projectPath, agent.id, choice, force || undefined);
    } catch (err) {
      // telemetry-exempt: shown in the dialog; nothing changed.
      setPhase({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (result.ok) {
      await reloadProjectAgents(agent.projectId, projectPath, choice === 'dispose' ? result.helperIds ?? [] : []);
      onDone(result.policy);
      return;
    }
    // Some helpers may have gone before one failed; the rail drops those.
    if (choice === 'dispose' && (result.helperIds?.length ?? 0) > 0) {
      await reloadProjectAgents(agent.projectId, projectPath, result.helperIds);
    }
    // Off even so: main turned orchestration off and only some helpers failed.
    if (result.policy && !result.policy.orchestrate) {
      if (choice !== 'dispose' || !result.helperIds?.length) await reloadProjectAgents(agent.projectId, projectPath);
      const names = result.failed?.map((f) => `${f.name} (${f.reason})`);
      setPhase({
        kind: 'partial',
        policy: result.policy,
        message: names?.length
          ? `Orchestration is off, but ${names.join(', ')} couldn’t be settled and ${names.length === 1 ? 'stays as it was' : 'stay as they were'}.`
          : `Orchestration is off, but some helpers couldn’t be settled. ${result.message}.`,
      });
      return;
    }
    if (result.blocked && result.blocked.length > 0) {
      setPhase({ kind: 'blocked', blocked: result.blocked, message: result.message });
    } else {
      const failed = result.failed?.map((f) => `${f.name} (${f.reason})`).join(', ');
      setPhase({ kind: 'failed', message: failed ? `${result.message}. ${failed} couldn’t be disposed.` : result.message });
    }
  };

  const blocked = phase.kind === 'blocked' ? phase.blocked : [];
  // Force overrides work at risk only, never a check that couldn't run.
  const forceable = blocked.length > 0 && blocked.every((b) => !b.checks.error);

  let footer;
  if (phase.kind === 'partial') {
    footer = <Button kind="primary" onClick={() => onDone(phase.policy)} data-testid="turn-off-close">Close</Button>;
  } else if (phase.kind === 'blocked') {
    footer = (
      <>
        <Button kind="quiet" onClick={cancel} data-testid="turn-off-cancel">Cancel</Button>
        <Button kind="ghost" onClick={() => void run('keep')} data-testid="turn-off-keep">Keep helpers as normal agents</Button>
        {forceable && <Button kind="danger-solid" onClick={() => void run('dispose', true)} data-testid="turn-off-force">Dispose anyway</Button>}
      </>
    );
  } else {
    footer = (
      <>
        <Button kind="quiet" onClick={cancel} disabled={working} data-testid="turn-off-cancel">Cancel</Button>
        <Button kind="ghost" onClick={() => void run('dispose')} disabled={working} data-testid="turn-off-dispose">
          {working && phase.choice === 'dispose' ? 'Disposing…' : 'Dispose helpers'}
        </Button>
        <Button kind="primary" onClick={() => void run('keep')} disabled={working} data-testid="turn-off-keep">
          {working && phase.choice === 'keep' ? 'Keeping…' : 'Keep helpers as normal agents'}
        </Button>
      </>
    );
  }

  return (
    <Modal open onClose={cancel} title={`Stop ${agent.name} orchestrating?`} width="w-[520px]" testId="turn-off-orchestration" footer={footer}>
      {phase.kind === 'partial' ? (
        <p className="text-[13px] text-ctp-subtext1 leading-normal" role="alert" data-testid="turn-off-partial">{phase.message}</p>
      ) : phase.kind === 'blocked' ? (
        <div className="flex flex-col gap-3 text-[13px] text-ctp-subtext1 leading-normal">
          <p>
            {blocked.length === 1
              ? `${blocked[0].name} has work that disposing would lose, so nothing was disposed and orchestration is still on.`
              : `${plural(blocked.length, 'helper has', 'helpers have')} work that disposing would lose, so nothing was disposed and orchestration is still on.`}
          </p>
          <ul className="flex flex-col gap-2" data-testid="turn-off-blocked">
            {blocked.map((b) => (
              <li key={b.agentId}>
                <div className="text-ctp-text font-medium">{b.name}</div>
                <CheckList lines={checkLines(b.checks).filter((l) => l.kind === 'risk' || l.kind === 'failed')} />
              </li>
            ))}
          </ul>
          <p className="text-xs text-ctp-overlay1" data-testid="turn-off-blocked-note">
            {forceable
              ? 'Dispose anyway deletes this work along with the helpers’ folders.'
              : 'A helper that couldn’t be checked can’t be disposed. Keep the helpers, or cancel and try again once the check can run.'}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-[13px] text-ctp-subtext1 leading-normal">
          <p>
            {agent.name} has {plural(count, 'helper', 'helpers')}. Turning this off removes its helper and connection tools,
            so it can no longer start, message or dispose of {count === 1 ? 'it' : 'them'}.
          </p>
          {helpers.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs" data-testid="turn-off-helpers">
              {helpers.map((h) => (
                <li key={h.id} className="flex items-center gap-2">
                  <span className="text-ctp-text">{h.name}</span>
                  <span className="text-ctp-overlay1">{HELPER_STATE_LABEL[helperState(h, rail[h.id])].toLowerCase()}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ctp-overlay1">
            Keeping clears the parent link and leaves them running. Disposing stops them and deletes their folders,
            after checking that no work would be lost.
          </p>
          {phase.kind === 'failed' && <p className="text-xs text-ctp-error" role="alert" data-testid="turn-off-error">{phase.message}</p>}
        </div>
      )}
    </Modal>
  );
}
