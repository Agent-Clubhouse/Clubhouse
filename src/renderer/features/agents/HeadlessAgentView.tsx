import { useMemo, useState } from 'react';
import type { Agent } from '../../../shared/types';
import { useAgentStore } from '../../stores/agentStore';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { PopOutIcon } from './useAgentRowActions';
import { RunMonitor, type RunInfo } from './states/RunMonitor';
import type { RunPhase } from './states/Treehouse';
import { changedPaths } from './states/timeline';
import { useNow, useRunTranscript } from './states/useRunTranscript';
import { useRunFiles } from './states/useDiffStats';
import { FileDiffInset, StopIcon, TerminalIcon, TranscriptInset } from './states/RunInsets';
import { ModelLabel, ToolbarSeparator } from './states/parts';
import { Button } from '../../components/Button';
import { Tooltip } from '../../components/Tooltip';

interface Props {
  agent: Agent;
  /** In a popout: the summary stacks under the timeline, and Pop out and Stop live in the title bar. */
  stacked?: boolean;
}

/** Map the live agent's status to the monitor's phase. */
function livePhase(agent: Agent, hasSteps: boolean, finished: boolean): RunPhase {
  if (agent.status === 'error') return 'fail';
  // Exited, waiting for the completed record: show the outcome as soon as it's known
  if (agent.status === 'sleeping') return finished ? 'done' : 'run';
  return hasSteps ? 'run' : 'start';
}

/**
 * A running headless quick agent (#2019): the run monitor, live. When the run
 * ends the completed record takes over in the same layout (HeadlessRunFinished).
 */
export function HeadlessAgentView({ agent, stacked }: Props) {
  const killAgent = useAgentStore((s) => s.killAgent);
  const spawnedAt = useAgentStore((s) => s.agentSpawnedAt[agent.id]);
  const parentName = useAgentStore((s) => (agent.parentAgentId ? s.agents[agent.parentAgentId]?.name : undefined));
  const active = agent.status !== 'sleeping' && agent.status !== 'error';
  const { steps, totals, toolTick } = useRunTranscript(agent.id, true);
  const now = useNow(active);
  const [confirmKill, setConfirmKill] = useState(false);
  const [inset, setInset] = useState<{ kind: 'transcript' } | { kind: 'file'; path: string } | null>(null);

  const cwd = agent.runCwd ?? agent.worktreePath;
  const paths = useMemo(() => changedPaths(steps, cwd), [steps, cwd]);
  const files = useRunFiles(paths, cwd, agent.runBaseSha, toolTick);

  const phase = livePhase(agent, steps.length > 0, totals.summary !== null);
  const run: RunInfo = {
    name: agent.name,
    mission: agent.mission ?? '',
    orchestrator: agent.orchestrator,
    model: agent.model,
    parentName,
    phase,
    startedAt: spawnedAt,
    summary: totals.summary,
    error: agent.errorMessage,
    exitCode: agent.exitCode,
  };

  const actions = (
    <>
      <ModelLabel orchestrator={agent.orchestrator} model={agent.model} />
      <ToolbarSeparator />
      <Button
        kind="quiet"
        icon={<TerminalIcon />}
        aria-pressed={inset?.kind === 'transcript'}
        onClick={() => setInset(inset?.kind === 'transcript' ? null : { kind: 'transcript' })}
        data-testid="run-transcript-button"
      >
        Transcript
      </Button>
      {!stacked && (
        <Tooltip content="Pop out">
          <Button
            kind="quiet"
            icon={<PopOutIcon />}
            aria-label="Pop out"
            data-testid="run-popout-button"
            onClick={() => {
              void window.clubhouse.window.createPopout({ type: 'agent', agentId: agent.id, projectId: agent.projectId, title: `Agent — ${agent.name}` });
            }}
          />
        </Tooltip>
      )}
      {active && !stacked && (
        <Button kind="danger" icon={<StopIcon />} onClick={() => setConfirmKill(true)} data-testid="stop-agent-button">
          Stop…
        </Button>
      )}
    </>
  );

  return (
    <>
      <RunMonitor
        testId="headless-agent-view"
        run={run}
        steps={steps}
        totals={totals}
        files={files}
        cwd={cwd}
        now={now}
        stacked={stacked}
        actions={actions}
        selectedFile={inset?.kind === 'file' ? inset.path : null}
        onSelectFile={cwd ? (path) => setInset(inset?.kind === 'file' && inset.path === path ? null : { kind: 'file', path }) : undefined}
        inset={inset?.kind === 'transcript'
          ? <TranscriptInset agentId={agent.id} onClose={() => setInset(null)} />
          : inset?.kind === 'file' && cwd
            ? <FileDiffInset cwd={cwd} path={inset.path} onClose={() => setInset(null)} />
            : undefined}
      />
      <ConfirmDestructiveAction
        open={confirmKill}
        title={`Stop ${agent.name}?`}
        description="The run stops now. Changes it already made stay in the worktree."
        confirmLabel="Stop"
        onConfirm={() => { setConfirmKill(false); void killAgent(agent.id); }}
        onCancel={() => setConfirmKill(false)}
      />
    </>
  );
}
