import { useMemo, useState } from 'react';
import { CompletedQuickAgent } from '../../../shared/types';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { getOrchestratorLabel, formatModelLabel } from './orchestrator-colors';
import { HeadlessRunFinished, completedFailed } from './states/HeadlessRunFinished';
import { useRunFiles } from './states/useDiffStats';
import { DiffIcon, FileDiffInset } from './states/RunInsets';
import { runDetail } from './states/RunMonitor';
import { DiffStat, FileRow, ModelLabel, SectionHead, StateToolbar, ToolbarSeparator } from './states/parts';
import { Button } from '../../components/Button';
import { formatAgo, formatDuration, relativeTo } from './states/format';

interface Props {
  completed: CompletedQuickAgent;
  onDismiss: () => void;
  onDelete?: () => void;
}

/** "Read, Edit, Write and Bash". */
function listTools(tools: string[]): string {
  if (tools.length <= 1) return tools.join('');
  return `${tools.slice(0, -1).join(', ')} and ${tools[tools.length - 1]}`;
}

/**
 * A finished quick agent (#2019): the same header, summary and file rows as a
 * finished headless run, with no chips. Headless runs get the full monitor.
 */
export function QuickAgentGhost({ completed, onDismiss, onDelete }: Props) {
  if (completed.headless) return <HeadlessRunFinished completed={completed} onDismiss={onDismiss} onDelete={onDelete} />;
  return <QuickAgentFinished completed={completed} onDismiss={onDismiss} onDelete={onDelete} />;
}

function QuickAgentFinished({ completed, onDismiss, onDelete }: Props) {
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const failed = completedFailed(completed);
  const cwd = completed.cwd;
  const paths = useMemo(() => completed.filesModified.map((f) => relativeTo(f, cwd)), [completed.filesModified, cwd]);
  const files = useRunFiles(paths, cwd, completed.baseSha, completed.id);
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const now = Date.now();

  const startedAt = completed.startedAt ?? (completed.durationMs !== undefined ? completed.completedAt - completed.durationMs : undefined);
  const detail = runDetail({
    name: completed.name,
    mission: completed.mission,
    phase: failed ? 'fail' : 'done',
    startedAt,
    endedAt: completed.completedAt,
    exitCode: completed.exitCode,
    cancelled: completed.cancelled,
  }, now);

  const meta = [
    completed.name,
    'quick agent',
    getOrchestratorLabel(completed.orchestrator || 'claude-code', allOrchestrators),
    completed.model && completed.model !== 'default' ? completed.model : null,
    completed.cancelled ? 'stopped' : `exit ${completed.exitCode}`,
  ].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col h-full bg-ctp-base" data-testid="quick-agent-finished" data-failed={failed || undefined}>
      <StateToolbar
        status={failed ? 'error' : 'done'}
        detail={detail}
        testId="quick-finished-toolbar"
        right={(
          <>
            <ModelLabel orchestrator={completed.orchestrator} model={completed.model} />
            <ToolbarSeparator />
            {files.length > 0 && cwd && (
              <Button kind="ghost" icon={<DiffIcon />} onClick={() => setSelected(files[0].path)} data-testid="quick-review-button">
                Review changes
              </Button>
            )}
            <Button kind="quiet" onClick={onDismiss} data-testid="quick-dismiss-button">Dismiss</Button>
            {onDelete && (
              <Button kind="danger" onClick={() => setConfirmDelete(true)} data-testid="quick-delete-button">Delete…</Button>
            )}
          </>
        )}
      />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-[760px] mx-auto px-7 pt-[30px] pb-8 flex flex-col gap-1.5">
          <h1 className="text-[15px] leading-normal font-normal text-ctp-text break-words" data-testid="quick-mission">{completed.mission}</h1>
          <div className="text-xs text-ctp-overlay1">{meta}</div>
          {completed.summary ? (
            <p className="mt-2.5 text-[13px] leading-[1.55] text-ctp-subtext1 whitespace-pre-wrap break-words" data-testid="quick-summary">{completed.summary}</p>
          ) : (
            <p className="mt-2.5 text-[13px] leading-[1.55] text-ctp-overlay1" data-testid="quick-summary">
              {completed.cancelled ? 'Stopped before it wrote a summary.' : 'It ended without writing a summary.'}
            </p>
          )}
          {completed.stderrTail && failed && (
            <pre className="mt-1 px-2.5 py-2 rounded-md bg-ctp-crust font-mono text-xs leading-normal text-ctp-subtext1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {completed.stderrTail}
            </pre>
          )}

          {selected && cwd && (
            <div className="mt-5">
              <FileDiffInset cwd={cwd} path={selected} base={completed.baseSha} onClose={() => setSelected(null)} />
            </div>
          )}

          {files.length > 0 && (
            <section className="mt-5" aria-label="Files changed" data-testid="quick-files">
              <SectionHead
                title="Files changed"
                right={<span className="flex items-center gap-1.5">{files.length} · <DiffStat added={added} removed={removed} /></span>}
              />
              <div className="border-t border-surface-0 pt-1">
                {files.map((f) => (
                  <FileRow
                    key={f.path}
                    path={f.path}
                    added={f.added}
                    removed={f.removed}
                    binary={f.binary}
                    height={30}
                    selected={selected === f.path}
                    onClick={cwd ? () => setSelected(selected === f.path ? null : f.path) : undefined}
                  />
                ))}
              </div>
            </section>
          )}

          {(completed.toolsUsed?.length || completed.durationMs !== undefined) && (
            <p className="mt-3 text-xs text-ctp-overlay1" data-testid="quick-tools">
              {[
                completed.toolsUsed?.length ? `Used ${listTools(completed.toolsUsed)}` : null,
                completed.durationMs !== undefined ? `ran for ${formatDuration(completed.durationMs)}` : null,
              ].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
      </div>
      {onDelete && (
        <ConfirmDestructiveAction
          open={confirmDelete}
          title={`Delete ${completed.name}?`}
          description="This removes it from the finished list. Changes it made stay in the worktree."
          confirmLabel="Delete"
          onConfirm={() => { setConfirmDelete(false); onDelete(); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

/** Compact row for the classic sidebar AgentList. Metadata as plain text; Dismiss reachable by keyboard. */
export function QuickAgentGhostCompact({ completed, onDismiss, onDelete: _onDelete, onSelect, isNested }: Props & { onSelect?: () => void; isNested?: boolean }) {
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const failed = completedFailed(completed);
  const meta = [
    getOrchestratorLabel(completed.orchestrator || 'claude-code', allOrchestrators),
    completed.model ? formatModelLabel(completed.model) : null,
  ].filter(Boolean).join(' · ');
  const detail = [
    completed.summary || (completed.cancelled ? 'Stopped' : 'Interrupted'),
    completed.filesModified.length > 0 ? `${completed.filesModified.length} file${completed.filesModified.length === 1 ? '' : 's'}` : null,
    completed.durationMs != null ? formatDuration(completed.durationMs) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div
      className={`flex items-center gap-2 py-2 group hover:bg-surface-0 focus-within:bg-surface-0 transition-colors cursor-pointer ${isNested ? 'pl-7 pr-3' : 'px-3'}`}
      onClick={onSelect}
    >
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 ${failed ? 'bg-ctp-error' : 'bg-ctp-info'}`}
        role="img"
        aria-label={failed ? 'Error' : 'Done'}
      />
      <button
        type="button"
        className="flex-1 min-w-0 text-left focus-ring rounded"
        onClick={(e) => { e.stopPropagation(); onSelect?.(); }}
      >
        <div className="text-xs text-ctp-text truncate">{completed.mission}</div>
        <div className="text-xs text-ctp-overlay1 truncate mt-0.5">
          <span>{meta}</span>
          {detail && <span> · {detail}</span>}
        </div>
      </button>
      <span className="text-xs text-ctp-overlay0 flex-shrink-0">{formatAgo(completed.completedAt)}</span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface-1 text-ctp-overlay1 hover:text-ctp-text cursor-pointer opacity-0 group-hover:opacity-100 focus-visible:opacity-100 focus-ring transition-opacity flex-shrink-0"
        title="Dismiss"
        aria-label={`Dismiss ${completed.name}`}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 6L6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
