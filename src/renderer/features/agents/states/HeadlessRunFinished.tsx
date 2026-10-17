import { useMemo, useState } from 'react';
import type { CompletedQuickAgent } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { ConfirmDestructiveAction } from '../../../components/ConfirmDestructiveAction';
import { RunMonitor, type RunInfo } from './RunMonitor';
import { changedPaths, type RunTotals } from './timeline';
import { useNow, useRunTranscript } from './useRunTranscript';
import { useRunFiles } from './useDiffStats';
import { DiffIcon, FileDiffInset, TerminalIcon, TranscriptInset } from './RunInsets';
import { ModelLabel, ToolbarSeparator } from './parts';
import { Button } from '../../../components/Button';
import { relativeTo } from './format';

interface Props {
  completed: CompletedQuickAgent;
  onDismiss: () => void;
  onDelete?: () => void;
  /** Called after Retry starts the new run, so the caller can drop this record. */
  onRetried?: () => void;
  stacked?: boolean;
}

export function completedFailed(c: CompletedQuickAgent): boolean {
  return !!c.cancelled || c.exitCode !== 0;
}

/**
 * A finished or failed headless run, in the same layout it ran in (#2019):
 * finished adds the summary and Review changes; failed shows the error and
 * Retry, which continues in the same worktree.
 */
export function HeadlessRunFinished({ completed, onDismiss, onDelete, onRetried, stacked }: Props) {
  const spawnQuickAgent = useAgentStore((s) => s.spawnQuickAgent);
  const parentName = useAgentStore((s) => (completed.parentAgentId ? s.agents[completed.parentAgentId]?.name : undefined));
  const projects = useProjectStore((s) => s.projects);
  const { steps, totals: parsed } = useRunTranscript(completed.id, false);
  // Only "finished 2m ago" moves, so a slow tick is enough
  const now = useNow(true, 30_000);
  const [inset, setInset] = useState<{ kind: 'transcript' } | { kind: 'file'; path: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const failed = completedFailed(completed);
  const cwd = completed.cwd;
  const paths = useMemo(() => {
    const recorded = completed.filesModified.map((f) => relativeTo(f, cwd));
    return recorded.length ? recorded : changedPaths(steps, cwd);
  }, [completed.filesModified, steps, cwd]);
  const files = useRunFiles(paths, cwd, completed.baseSha, completed.id);

  // The record's numbers win when the transcript is gone or was trimmed
  const totals: RunTotals = {
    ...parsed,
    toolCalls: parsed.toolCalls || completed.toolCalls || 0,
    inputTokens: parsed.inputTokens || completed.inputTokens || 0,
    outputTokens: parsed.outputTokens || completed.outputTokens || 0,
    costUsd: completed.costUsd ?? parsed.costUsd,
  };

  const startedAt = completed.startedAt ?? (completed.durationMs !== undefined ? completed.completedAt - completed.durationMs : undefined);
  const run: RunInfo = {
    name: completed.name,
    mission: completed.mission,
    orchestrator: completed.orchestrator,
    model: completed.model,
    parentName,
    phase: failed ? 'fail' : 'done',
    startedAt,
    endedAt: completed.completedAt,
    exitCode: completed.exitCode,
    cancelled: completed.cancelled,
    summary: completed.summary,
    error: completed.stderrTail || (failed ? completed.summary : null),
  };

  const project = projects.find((p) => p.id === completed.projectId);
  const retry = async () => {
    if (!project || retrying) return;
    setRetrying(true);
    try {
      await spawnQuickAgent(
        completed.projectId, project.path, completed.mission, completed.model, completed.parentAgentId,
        completed.orchestrator, completed.freeAgentMode, completed.pluginMetadata, completed.cwd,
      );
      onRetried?.();
    } catch {
      // telemetry-exempt: spawnQuickAgent marks the new agent failed, and its view shows why
    } finally {
      setRetrying(false);
    }
  };

  const toggleTranscript = () => setInset(inset?.kind === 'transcript' ? null : { kind: 'transcript' });
  const transcriptButton = (
    <Button kind="quiet" icon={<TerminalIcon />} aria-pressed={inset?.kind === 'transcript'} onClick={toggleTranscript} data-testid="run-transcript-button">
      Transcript
    </Button>
  );

  const actions = (
    <>
      <ModelLabel orchestrator={completed.orchestrator} model={completed.model} />
      <ToolbarSeparator />
      {failed ? (
        <>
          <Button kind="primary" onClick={() => { void retry(); }} disabled={!project || retrying} data-testid="run-retry-button">
            Retry
          </Button>
          {transcriptButton}
          <Button kind="quiet" onClick={onDismiss} data-testid="run-dismiss-button">Dismiss</Button>
        </>
      ) : (
        <>
          {files.length > 0 && cwd && (
            <Button kind="ghost" icon={<DiffIcon />} onClick={() => setInset({ kind: 'file', path: files[0].path })} data-testid="run-review-button">
              Review changes
            </Button>
          )}
          {transcriptButton}
          <Button kind="quiet" onClick={onDismiss} data-testid="run-dismiss-button">Dismiss</Button>
          {onDelete && (
            <Button kind="danger" onClick={() => setConfirmDelete(true)} data-testid="run-delete-button">Delete…</Button>
          )}
        </>
      )}
    </>
  );

  return (
    <>
      <RunMonitor
        testId="headless-run-finished"
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
          ? <TranscriptInset agentId={completed.id} onClose={() => setInset(null)} />
          : inset?.kind === 'file' && cwd
            ? <FileDiffInset cwd={cwd} path={inset.path} base={completed.baseSha} onClose={() => setInset(null)} />
            : undefined}
      />
      {onDelete && (
        <ConfirmDestructiveAction
          open={confirmDelete}
          title={`Delete ${completed.name}?`}
          description="This removes the run from the finished list. Changes it made stay in the worktree."
          confirmLabel="Delete"
          onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
}
