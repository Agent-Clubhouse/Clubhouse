/**
 * The headless run monitor (#2019): one layout from start to finish. A
 * toolbar with status and elapsed time, a header with the mission and the
 * treehouse, and a timeline with a 300px summary column beside it (stacked in
 * a popout or a pane under 800px). Finished adds the summary; failed shows the
 * error. The containers (HeadlessAgentView, the finished views) load the data
 * and pass the toolbar actions.
 */

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Treehouse, type RunPhase } from './Treehouse';
import {
  clock, describeFold, describeTool, foldSteps, toolCallBuckets,
  type FoldStep, type RunTotals, type Step, type TextStep, type ToolGlyph, type ToolStep,
} from './timeline';
import { DiffStat, FileRow, SectionHead, StateDot, StateToolbar, type StateDotKind } from './parts';
import { formatAgo, formatDuration, formatUsd, plural } from './format';
import { formatTokens } from '../chat/view-model';
import { getOrchestratorLabel } from '../orchestrator-colors';
import { matchStat } from './useDiffStats';

/** Below this width the summary column moves under the timeline. */
export const STACK_BELOW_PX = 800;
/** Rows rendered before older ones collapse behind "Show earlier steps". */
export const MAX_ROWS = 300;

export interface RunInfo {
  name: string;
  mission: string;
  orchestrator?: string;
  model?: string;
  /** Name of the durable agent that spawned it. */
  parentName?: string;
  phase: RunPhase;
  startedAt?: number;
  endedAt?: number;
  exitCode?: number;
  cancelled?: boolean;
  summary?: string | null;
  /** What went wrong: the stderr tail kept after exit, or the launch error. */
  error?: string | null;
}

export interface ChangedFileStat {
  path: string;
  added?: number;
  removed?: number;
  binary?: boolean;
}

export function runStatus(run: RunInfo): StateDotKind {
  return run.phase === 'done' ? 'done' : run.phase === 'fail' ? 'error' : 'working';
}

/** The toolbar's detail beside the status word. */
export function runDetail(run: RunInfo, now: number): string {
  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : undefined;
  if (run.phase === 'start') return 'headless · starting';
  if (run.phase === 'run') return `headless · ${formatDuration(elapsed ?? 0)}`;
  const ago = run.endedAt ? ` · ${formatAgo(run.endedAt, now)}` : '';
  if (run.phase === 'done') return elapsed !== undefined ? `finished in ${formatDuration(elapsed)}${ago}` : `finished${ago}`;
  if (run.cancelled) return elapsed !== undefined ? `stopped after ${formatDuration(elapsed)}` : 'stopped';
  const code = run.exitCode !== undefined ? `exited with code ${run.exitCode}` : 'failed';
  return elapsed !== undefined ? `${code} after ${formatDuration(elapsed)}` : code;
}

function useStacked(ref: React.RefObject<HTMLElement | null>, force?: boolean): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (force || !el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      setNarrow(w > 0 && w < STACK_BELOW_PX);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, force]);
  return force || narrow;
}

/* ── Icons ────────────────────────────────────────────────────────── */

const GLYPH_PATHS: Record<ToolGlyph | 'check' | 'stop', ReactNode> = {
  file: <><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  pencil: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M14 6l4 4" /></>,
  term: <><path d="M4 6l6 6-6 6" /><path d="M12 18h8" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  tool: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
  check: <path d="M5 12l5 5 9-10" />,
  stop: <><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></>,
};

export function Glyph({ name, size = 14 }: { name: keyof typeof GLYPH_PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPH_PATHS[name]}
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={open ? 'rotate-90' : ''}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/* ── Timeline rows ────────────────────────────────────────────────── */

interface RowContext {
  start: number;
  base?: string;
  stats: Map<string, ChangedFileStat>;
  /** The step still running (live) or where a failed run stopped. */
  currentId?: string;
  phase: RunPhase;
}

function Time({ ts, start }: { ts: number; start: number }) {
  return <span className="flex-shrink-0 w-[38px] font-mono text-[11px] text-ctp-overlay0 tabular-nums">{clock(ts, start)}</span>;
}

function statFor(path: string | undefined, stats: Map<string, ChangedFileStat>): ChangedFileStat | undefined {
  if (!path) return undefined;
  return stats.get(path) ?? matchStat(path, [...stats.values()]);
}

function ToolRow({ step, ctx, nested }: { step: ToolStep; ctx: RowContext; nested?: boolean }) {
  const d = describeTool(step, ctx.base);
  const current = step.id === ctx.currentId;
  const running = current && (ctx.phase === 'run' || ctx.phase === 'start');
  const stopped = current && ctx.phase === 'fail';
  let meta: ReactNode = null;
  if (running) meta = <span className="flex items-center gap-1.5 text-xs text-ctp-overlay1"><StateDot kind="working" />running</span>;
  else if (stopped) meta = <span className="flex items-center gap-1.5 text-xs text-ctp-error"><StateDot kind="error" />stopped here</span>;
  else if (d.changedPath) {
    const s = statFor(d.changedPath, ctx.stats);
    meta = s ? <DiffStat added={s.added} removed={s.removed} /> : null;
  } else if (d.glyph === 'term' && step.endTs !== undefined) meta = <span className="text-xs text-ctp-overlay1">{step.isError ? 'failed' : 'passed'}</span>;
  else if (step.isError) meta = <span className="text-xs text-ctp-overlay1">failed</span>;

  return (
    <div
      className={`h-[30px] flex items-center gap-2 px-2 -mx-2 rounded-md min-w-0 ${running ? 'bg-surface-0' : ''} ${nested ? 'pl-[54px]' : ''}`}
      data-testid="timeline-tool"
      data-tool={step.name}
    >
      {!nested && <Time ts={step.ts} start={ctx.start} />}
      <span className="flex-shrink-0 flex text-ctp-overlay1"><Glyph name={d.glyph} /></span>
      <span className="flex-shrink-0 text-[13px] text-ctp-text">{running ? d.active : d.verb}</span>
      {d.target && (
        <span className={`min-w-0 truncate text-ctp-subtext1 ${d.mono ? 'font-mono text-xs' : 'text-[13px]'} ${d.detail ? 'flex-shrink-0 max-w-[50%]' : ''}`} title={d.target}>
          {d.target}
        </span>
      )}
      {d.detail && <span className="min-w-0 truncate text-xs text-ctp-overlay1">{d.detail}</span>}
      {meta && <span className="ml-auto flex-shrink-0 pl-2">{meta}</span>}
    </div>
  );
}

function FoldRow({ fold, ctx }: { fold: FoldStep; ctx: RowContext }) {
  const [open, setOpen] = useState(false);
  const names = fold.steps.map((s) => describeTool(s, ctx.base).target).join(', ');
  const hasCurrent = fold.steps.some((s) => s.id === ctx.currentId);
  return (
    <div data-testid="timeline-fold">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full h-[30px] flex items-center gap-2 px-2 -mx-2 rounded-md text-left min-w-0 hover:bg-surface-0 cursor-pointer focus-ring"
      >
        <Time ts={fold.ts} start={ctx.start} />
        <span className="flex-shrink-0 flex items-center text-ctp-overlay1"><Chevron open={open} /><Glyph name="file" /></span>
        <span className="flex-shrink-0 text-[13px] text-ctp-text">{describeFold(fold.steps)}</span>
        {!open && <span className="min-w-0 truncate text-xs text-ctp-overlay1">{names}</span>}
        {hasCurrent && !open && ctx.phase === 'run' && (
          <span className="ml-auto flex-shrink-0 flex items-center gap-1.5 text-xs text-ctp-overlay1"><StateDot kind="working" />running</span>
        )}
      </button>
      {open && fold.steps.map((s) => <ToolRow key={s.id} step={s} ctx={ctx} nested />)}
    </div>
  );
}

function TextRow({ step, start }: { step: TextStep; start: number }) {
  return (
    <div className="flex gap-2 pt-[5px] pb-[7px]" data-testid="timeline-text">
      <Time ts={step.ts} start={start} />
      <p className="flex-1 min-w-0 text-[13px] leading-[1.55] text-ctp-subtext1 whitespace-pre-wrap break-words line-clamp-6">{step.text}</p>
    </div>
  );
}

function EndRow({ run, start }: { run: RunInfo; start: number }) {
  const done = run.phase === 'done';
  return (
    <div className="h-[30px] flex items-center gap-2 px-2 -mx-2 rounded-md" data-testid="timeline-end">
      <Time ts={run.endedAt ?? start} start={start} />
      <span className={`flex-shrink-0 flex ${done ? 'text-ctp-success' : 'text-ctp-error'}`}><Glyph name={done ? 'check' : 'stop'} /></span>
      <span className="text-[13px] text-ctp-text">{done ? 'Finished' : run.cancelled ? 'Stopped' : 'Exited'}</span>
      {run.exitCode !== undefined && <span className="text-[13px] text-ctp-subtext1">exit {run.exitCode}</span>}
    </div>
  );
}

/* ── The monitor ──────────────────────────────────────────────────── */

export interface RunMonitorProps {
  run: RunInfo;
  steps: Step[];
  totals: RunTotals;
  files: ChangedFileStat[];
  /** Directory the run worked in, to show paths relative to it. */
  cwd?: string;
  now: number;
  /** Toolbar buttons on the right. */
  actions?: ReactNode;
  /** Force the stacked layout (popouts). */
  stacked?: boolean;
  /** Shown above the activity column: a file diff or the transcript. */
  inset?: ReactNode;
  selectedFile?: string | null;
  onSelectFile?: (path: string) => void;
  testId?: string;
}

export function RunMonitor({ run, steps, totals, files, cwd, now, actions, stacked: forceStacked, inset, selectedFile, onSelectFile, testId = 'run-monitor' }: RunMonitorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stacked = useStacked(rootRef, forceStacked);
  const [showAll, setShowAll] = useState(false);
  const start = run.startedAt ?? steps[0]?.ts ?? now;
  const live = run.phase === 'run' || run.phase === 'start';
  const elapsed = (run.endedAt ?? now) - start;

  const rows = useMemo(() => foldSteps(steps.filter((s) => s.kind !== 'result')), [steps]);
  const stats = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const currentId = useMemo(() => {
    if (run.phase === 'done') return undefined;
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i];
      if (s.kind === 'tool') return s.endTs === undefined ? s.id : undefined;
    }
    return undefined;
  }, [steps, run.phase]);
  const ctx: RowContext = { start, base: cwd, stats, currentId, phase: run.phase };

  const totalsAdded = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const totalsRemoved = files.reduce((n, f) => n + (f.removed ?? 0), 0);
  const eventCount = rows.length;

  const meta = [
    run.name,
    run.parentName ? `quick agent from ${run.parentName}` : 'quick agent',
    getOrchestratorLabel(run.orchestrator || 'claude-code'),
    run.model && run.model !== 'default' ? run.model : null,
    run.startedAt ? `started ${startedLabel(run.startedAt, now)}` : null,
  ].filter(Boolean).join(' · ');

  const cost = totals.costUsd !== undefined ? formatUsd(totals.costUsd) : live ? (run.phase === 'start' ? 'not yet' : 'reported at the end') : 'not reported';
  const buckets = run.phase === 'start' ? [] : toolCallBuckets(steps, start, Math.max(start + 1, run.endedAt ?? now));
  const peak = Math.max(1, ...buckets);

  const timeline = (
    <div className="flex-1 min-w-0" data-testid="run-activity">
      <SectionHead
        title="Activity"
        right={live
          ? <span className="flex items-center gap-1.5"><StateDot kind="working" />live</span>
          : plural(eventCount, 'event')}
      />
      <div className="border-t border-surface-0 pt-1">
        {!showAll && rows.length > MAX_ROWS && (
          <button type="button" onClick={() => setShowAll(true)} className="h-7 text-xs text-ctp-accent hover:underline cursor-pointer focus-ring rounded" data-testid="run-show-earlier">
            Show {plural(rows.length - MAX_ROWS, 'earlier step')}
          </button>
        )}
        {rows.length === 0 && live ? (
          <div data-testid="run-starting">
            <div className="h-[30px] flex items-center gap-2 text-[13px] text-ctp-subtext1"><StateDot kind="working" />Starting {run.name}</div>
            <p className="pl-4 text-xs leading-normal text-ctp-overlay1">The first step shows here as soon as the CLI reports it, usually within a few seconds.</p>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-1 text-xs text-ctp-overlay1">No steps were recorded for this run.</p>
        ) : (
          (showAll ? rows : rows.slice(-MAX_ROWS)).map((r) => r.kind === 'text' ? <TextRow key={r.id} step={r} start={start} />
            : r.kind === 'fold' ? <FoldRow key={r.id} fold={r} ctx={ctx} />
              : r.kind === 'tool' ? <ToolRow key={r.id} step={r} ctx={ctx} />
                : null)
        )}
        {!live && (run.phase === 'done' || currentId === undefined) && <EndRow run={run} start={start} />}
      </div>
    </div>
  );

  const summaryColumn = (
    <div className={`flex flex-col gap-[18px] ${stacked ? 'w-full' : 'flex-none w-[300px]'}`} data-testid="run-summary">
      <div>
        <SectionHead title="Progress" />
        <Stat label="Elapsed" value={formatDuration(elapsed)} />
        <Stat label="Tool calls" value={String(totals.toolCalls)} />
        <Stat label="Tokens" value={totals.inputTokens || totals.outputTokens ? `${formatTokens(totals.inputTokens)} in, ${formatTokens(totals.outputTokens)} out` : '0'} />
        <Stat label="Cost" value={cost} />
        {buckets.length > 0 && (
          <div aria-label="Tool calls per 20 seconds" role="img">
            <div className="flex items-end gap-[3px] h-7 mt-1.5 mb-0.5 overflow-hidden">
              {buckets.slice(-40).map((n, i, arr) => (
                <span
                  key={i}
                  className={`w-1.5 flex-shrink-0 rounded-sm ${live && i === arr.length - 1 ? 'bg-ctp-info' : 'bg-surface-2'}`}
                  style={{ height: 4 + Math.round((n / peak) * 20) }}
                />
              ))}
            </div>
            <div className="text-xs text-ctp-overlay1">Tool calls per 20 seconds</div>
          </div>
        )}
      </div>
      <div data-testid="run-files">
        <SectionHead
          title="Files changed"
          right={files.length ? <span className="flex items-center gap-1.5">{files.length} · <DiffStat added={totalsAdded} removed={totalsRemoved} /></span> : undefined}
        />
        {files.length ? files.map((f) => (
          <FileRow
            key={f.path}
            path={f.path}
            added={f.added}
            removed={f.removed}
            binary={f.binary}
            selected={selectedFile === f.path}
            onClick={onSelectFile ? () => onSelectFile(f.path) : undefined}
          />
        )) : <p className="py-1 text-xs text-ctp-overlay1">{live ? 'None yet' : 'None'}</p>}
        {run.phase === 'fail' && files.length > 0 && (
          <p className="mt-1.5 text-xs leading-normal text-ctp-overlay1">The worktree keeps these changes. Retry continues from them.</p>
        )}
      </div>
    </div>
  );

  return (
    <div ref={rootRef} className="flex flex-col h-full bg-ctp-base" data-testid={testId} data-phase={run.phase} data-stacked={stacked || undefined}>
      <StateToolbar status={runStatus(run)} detail={runDetail(run, now)} right={actions} testId="run-toolbar" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className={`max-w-[1000px] mx-auto pb-8 ${stacked ? 'px-4 pt-4' : 'px-8 pt-[26px]'}`}>
          <header className="flex gap-[22px] items-center pb-[18px] border-b border-surface-0" data-testid="run-header">
            <Treehouse phase={run.phase} size={stacked ? 64 : 96} />
            <div className="flex-1 min-w-0 flex flex-col gap-1.5">
              <h1 className="text-[15px] leading-normal font-normal text-ctp-text break-words" data-testid="run-mission">{run.mission}</h1>
              <div className="text-xs text-ctp-overlay1">{meta}</div>
              {run.phase === 'done' && run.summary && (
                <p className="mt-1 text-[13px] leading-[1.55] text-ctp-subtext1 whitespace-pre-wrap break-words" data-testid="run-summary-text">{run.summary}</p>
              )}
              {run.phase === 'fail' && run.error && (
                <pre className="mt-1 px-2.5 py-2 rounded-md bg-ctp-crust font-mono text-xs leading-normal text-ctp-subtext1 whitespace-pre-wrap break-words max-h-32 overflow-y-auto" data-testid="run-error">
                  {run.error}
                </pre>
              )}
            </div>
          </header>
          {inset && <div className="pt-4">{inset}</div>}
          <div className={stacked ? 'flex flex-col gap-6 pt-4' : 'flex gap-10 pt-4'}>
            {timeline}
            {summaryColumn}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="h-7 flex items-center gap-2 text-[12.5px]">
      <span className="text-ctp-overlay1">{label}</span>
      <span className="ml-auto text-ctp-text tabular-nums">{value}</span>
    </div>
  );
}

function startedLabel(at: number, now: number): string {
  if (now - at < 60_000) return 'just now';
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === d.toDateString() ? `today at ${time}` : `${d.toLocaleDateString()} at ${time}`;
}
