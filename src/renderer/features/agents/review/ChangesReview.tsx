/**
 * The Changes review (#2032, "Git, rethought"): an agent's branch against its
 * merge base with main, as a view beside Chat and Terminal. It replaces the
 * Git tab in the new layout.
 *
 * The list on the left holds uncommitted files with stage checkboxes and a
 * commit box (which can hand the message to the agent), the branch's own
 * commits, and a footer that pushes and opens the pull request. The right
 * shows every file in one scroll, each collapsible; very long and generated
 * files start collapsed. Every git result shows under the control that ran it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangedFile } from '../../../../shared/chat-checkpoints';
import type { BranchChanges, PullRequestInfo } from '../../../../shared/git-branch';
import type { GitInfo, GitLogEntry, GitOpResult, GitStatusFile } from '../../../../shared/types';
import { Button } from '../../../components/Button';
import { DiffCard } from '../chat/ToolBlocks';
import { PlusMinus } from '../details/DetailsCard';
import { totals } from '../details/ChangesCard';
import { holdChromeView } from '../../../chrome/telemetry';

type Diff = Parameters<typeof DiffCard>[0]['diff'];

/** What the right side shows. */
export type ReviewFocus = { kind: 'branch' } | { kind: 'uncommitted' } | { kind: 'commit'; hash: string; subject: string; shortHash: string };

/** Changed lines past which a file starts collapsed. */
export const LONG_FILE_LINES = 400;
const GENERATED = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)Cargo\.lock$/, /\.min\.(js|css)$/, /\.snap$/, /(^|\/)(dist|build|out)\//, /\.generated\./];

/** Long or generated files start collapsed in the scroll. */
export function startsCollapsed(file: Pick<ChangedFile, 'path' | 'additions' | 'deletions' | 'binary'>): boolean {
  return file.binary || file.additions + file.deletions > LONG_FILE_LINES || GENERATED.some((r) => r.test(file.path));
}

/** git status codes as a review row's letter and status. */
function statusFile(f: GitStatusFile): ChangedFile & { staged: boolean; untracked: boolean } {
  const code = f.status;
  const untracked = code === '??';
  const status: ChangedFile['status'] = untracked || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : code.includes('R') ? 'renamed' : 'modified';
  return { path: f.path, ...(f.origPath ? { oldPath: f.origPath } : {}), status, additions: 0, deletions: 0, binary: false, staged: f.staged, untracked };
}

const STATUS_LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const STATUS_TONE: Record<ChangedFile['status'], string> = {
  added: 'text-ctp-success', modified: 'text-ctp-warning', deleted: 'text-ctp-error', renamed: 'text-ctp-info',
};

function Section({ title, count, right, children }: { title: string; count?: number; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col">
      <div className="h-[30px] flex-shrink-0 flex items-center gap-1.5 pl-3.5 pr-3 text-xs font-semibold text-ctp-overlay1">
        {title}
        {count !== undefined && <span className="font-normal text-ctp-overlay0">{count}</span>}
        {right && <span className="ml-auto font-normal flex items-center gap-2">{right}</span>}
      </div>
      {children}
    </section>
  );
}

function Result({ result }: { result: GitOpResult | null }) {
  if (!result || result.ok) return null;
  return <p className="text-xs text-ctp-error break-words" role="alert" data-testid="review-error">{result.message || 'That didn’t work.'}</p>;
}

/** One file in the scroll: a header that collapses it, and its diff loaded on first open. */
function FileBlock({ file, loadDiff, staged, onDiscard, version }: {
  file: ChangedFile;
  /** Changes when the file may have changed (its stats, a refresh), so an open diff reloads. */
  version: string;
  loadDiff: (path: string) => Promise<Diff | null>;
  /** Uncommitted files only: whether it's staged. */
  staged?: boolean;
  onDiscard?: () => Promise<GitOpResult>;
}) {
  const [open, setOpen] = useState(() => !startsCollapsed(file));
  const [diff, setDiff] = useState<Diff | null | 'loading' | 'failed'>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<GitOpResult | null>(null);

  // Loaded once, the first time the file is opened.
  const wanted = open || diff !== null;
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    setDiff('loading');
    loadDiff(file.path).then(
      (d) => { if (!cancelled) setDiff(d ?? 'failed'); },
      () => { if (!cancelled) setDiff('failed'); },
    );
    return () => { cancelled = true; };
  }, [wanted, loadDiff, file.path, version]);

  return (
    <div className="flex-shrink-0 rounded-lg border border-surface-0 overflow-hidden" data-testid="review-file" data-path={file.path} data-open={open || undefined}>
      <div className={`h-8 flex items-center gap-2 px-2.5 bg-ctp-mantle text-xs text-ctp-overlay1 ${open ? 'border-b border-surface-0' : ''}`}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-2 min-w-0 flex-1 text-left"
          data-testid="review-file-toggle"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0 text-ctp-overlay0">
            <path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
          </svg>
          <span className={`flex-shrink-0 w-2.5 font-mono text-[11px] font-semibold ${STATUS_TONE[file.status]}`}>{STATUS_LETTER[file.status]}</span>
          <span className="font-mono text-[11.5px] text-ctp-text truncate" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.path}</span>
          {(file.additions > 0 || file.deletions > 0) && <PlusMinus added={file.additions} removed={file.deletions} />}
          {!open && startsCollapsed(file) && <span className="text-ctp-overlay0">{file.binary ? 'binary' : 'long or generated, collapsed'}</span>}
        </button>
        {staged !== undefined && <span className="flex-shrink-0">{staged ? 'Staged' : 'Not staged'}</span>}
        {onDiscard && !confirm && (
          <button type="button" onClick={() => setConfirm(true)} className="flex-shrink-0 hover:text-ctp-text" data-testid="review-discard">Discard…</button>
        )}
      </div>
      {confirm && (
        <div className="flex items-center gap-2 flex-wrap px-2.5 py-2 bg-ctp-mantle border-b border-surface-0 text-xs text-ctp-subtext0" data-testid="review-discard-confirm">
          <span>Discard your changes to {file.path.split('/').pop()}? This can&apos;t be undone.</span>
          <Button kind="danger-solid" onClick={() => { void onDiscard?.().then((r) => { setResult(r); setConfirm(false); }); }}>Discard</Button>
          <Button kind="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
        </div>
      )}
      {result && !result.ok && <div className="px-2.5 py-1.5"><Result result={result} /></div>}
      {open && (
        <div>
          {diff === 'loading' && <p className="px-3 py-2 text-xs text-ctp-overlay1">Loading…</p>}
          {diff === 'failed' && <p className="px-3 py-2 text-xs text-ctp-overlay1">No diff to show for this file.</p>}
          {diff && typeof diff === 'object' && <DiffCard diff={diff} />}
        </div>
      )}
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(fn).then(
      (v) => { if (!cancelled) setValue(v); },
      // telemetry-exempt: the review shows what loaded; a failed read leaves that part empty.
      () => { if (!cancelled) setValue(null); },
    );
    return () => { cancelled = true; };
  }, [...deps, tick]);
  return [value, useCallback(() => setTick((t) => t + 1), [])];
}

export interface ChangesReviewProps {
  agentName: string;
  cwd: string;
  /** The branch against main, shared with Agent details. */
  branch: BranchChanges | null;
  /** Re-read the branch after a commit, stage or discard. */
  onChanged: () => void;
  /** Hand the commit to the agent (chat agents). Omitted hides the button. */
  onAskAgent?: (message: string) => void;
  /** Changes when the agent's turn or hook status moves on, so the review stays current. */
  refreshKey?: unknown;
  /**
   * The project root (#2032): no branch to compare or pull request to open.
   * `aside` takes the right side in place of the branch's files.
   */
  root?: { aside: React.ReactNode };
}

export function ChangesReview({ agentName, cwd, branch, onChanged, onAskAgent, refreshKey, root }: ChangesReviewProps) {
  const [info, reloadInfo] = useAsync<GitInfo>(() => window.clubhouse.git.info(cwd), [cwd, refreshKey]);
  const [log, reloadLog] = useAsync<GitLogEntry[]>(() => (root ? Promise.resolve([]) : window.clubhouse.git.branchLog(cwd, undefined)), [cwd, refreshKey, !!root]);
  const [pr, reloadPr] = useAsync<PullRequestInfo | null>(() => (root ? Promise.resolve(null) : window.clubhouse.git.pullRequestInfo(cwd)), [cwd, !!root]);
  const [focus, setFocus] = useState<ReviewFocus>({ kind: 'branch' });
  const showAside = !!root && focus.kind === 'branch';
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, GitOpResult | null>>({});

  const uncommitted = useMemo(() => (info?.status ?? []).map(statusFile), [info]);
  const stagedCount = uncommitted.filter((f) => f.staged).length;

  const [reloads, setReloads] = useState(0);
  const refresh = useCallback(() => { reloadInfo(); reloadLog(); reloadPr(); onChanged(); setReloads((n) => n + 1); }, [reloadInfo, reloadLog, reloadPr, onChanged]);

  // The Git tab reported clubhouse.view = git; the review reports its own view while it shows.
  useEffect(() => holdChromeView('changes'), []);

  const run = async (key: string, op: () => Promise<GitOpResult>, after?: (r: GitOpResult) => void) => {
    setBusy(key);
    try {
      const r = await op();
      setResults((s) => ({ ...s, [key]: r }));
      after?.(r);
    } catch (err) {
      // telemetry-exempt: shown under the control that failed.
      setResults((s) => ({ ...s, [key]: { ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const toggleStage = (f: GitStatusFile & { staged: boolean }) =>
    run('stage', () => (f.staged ? window.clubhouse.git.unstage(cwd, f.path) : window.clubhouse.git.stage(cwd, f.path)));

  const openPr = async () => {
    setBusy('pr');
    try {
      let state = pr;
      if (!state?.pushed || (state.unpushed ?? 0) > 0) {
        const pushed = await window.clubhouse.git.pushBranch(cwd);
        if (!pushed.ok) { setResults((s) => ({ ...s, pr: pushed })); return; }
        state = await window.clubhouse.git.pullRequestInfo(cwd);
      }
      const url = state?.pr?.url ?? state?.compareUrl;
      if (!url) {
        setResults((s) => ({ ...s, pr: { ok: false, message: 'This remote isn’t on GitHub, so open the pull request on your git host.' } }));
        return;
      }
      // Main checks the page is this repository's on GitHub before opening it.
      setResults((s) => ({ ...s, pr: null }));
      const opened = await window.clubhouse.git.openPullRequest(cwd, url);
      setResults((s) => ({ ...s, pr: opened }));
    } catch (err) {
      // telemetry-exempt: shown under the button.
      setResults((s) => ({ ...s, pr: { ok: false, message: err instanceof Error ? err.message : String(err) } }));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  // Right side: the files in focus and how to load each one's diff.
  const [commitFiles] = useAsync<ChangedFile[]>(async () => {
    if (focus.kind !== 'commit') return [];
    const detail = await window.clubhouse.git.showCommit(cwd, focus.hash);
    return (detail?.files ?? []).map((f: { path: string; status: string; origPath?: string }) => ({
      path: f.path,
      ...(f.origPath ? { oldPath: f.origPath } : {}),
      status: f.status.startsWith('A') ? 'added' : f.status.startsWith('D') ? 'deleted' : f.status.startsWith('R') ? 'renamed' : 'modified',
      additions: 0, deletions: 0, binary: false,
    } as ChangedFile));
  }, [cwd, focus.kind === 'commit' ? focus.hash : null]);

  const loadBranchDiff = useCallback(async (p: string): Promise<Diff | null> => {
    const r = await window.clubhouse.git.branchFilePatch(cwd, p, undefined);
    if (r.binary || r.tooLarge) return null;
    if (r.patch) return { type: 'diff', path: p, unifiedDiff: r.patch };
    if (r.newText !== undefined) return { type: 'diff', path: p, newText: r.newText };
    return null;
  }, [cwd]);
  const stagedByPath = useMemo(() => new Map(uncommitted.map((f) => [f.path, f])), [uncommitted]);
  const loadUncommittedDiff = useCallback(async (p: string): Promise<Diff | null> => {
    const f = stagedByPath.get(p);
    const d = await window.clubhouse.git.diff(cwd, p, !!f?.staged && !f?.untracked);
    if (!d) return null;
    return { type: 'diff', path: p, oldText: d.original || undefined, newText: f?.status === 'deleted' ? undefined : d.modified };
  }, [cwd, stagedByPath]);
  const loadCommitDiff = useCallback(async (p: string): Promise<Diff | null> => {
    if (focus.kind !== 'commit') return null;
    const d = await window.clubhouse.git.commitDiff(cwd, focus.hash, p);
    if (!d) return null;
    return { type: 'diff', path: p, oldText: d.original || undefined, newText: d.modified || undefined };
  }, [cwd, focus]);

  const shown: ChangedFile[] = focus.kind === 'commit' ? commitFiles ?? [] : focus.kind === 'uncommitted' ? uncommitted : branch?.files ?? [];
  const loader = focus.kind === 'commit' ? loadCommitDiff : focus.kind === 'uncommitted' ? loadUncommittedDiff : loadBranchDiff;
  const { added, removed } = totals(shown);
  const base = branch?.base ?? pr?.base ?? 'main';
  const ahead = branch?.ahead ?? log?.length ?? 0;

  const prLine = pr?.pr
    ? <>Pull request #{pr.pr.number} <span className="text-ctp-overlay0">{pr.pr.state}</span></>
    : <>No pull request yet <span className="ml-auto text-ctp-overlay0">{!pr?.hasRemote ? 'no remote' : !pr.pushed ? 'not pushed' : pr.unpushed ? `${pr.unpushed} to push` : 'pushed'}</span></>;
  const prButton = pr?.pr ? 'Open pull request' : !pr?.pushed || (pr.unpushed ?? 0) > 0 ? 'Push and open PR…' : 'Open pull request…';
  // Why the footer's buttons can't do anything, said instead of just disabling them.
  const blocker = !pr ? null
    : pr.available && !pr.branch ? 'HEAD is detached. Check out a branch to push it or open a pull request.'
      : !pr.hasRemote ? 'This repository has no remote to push to (or several, and none is origin).'
        : null;
  const canPush = !blocker && !(pr?.pushed && !pr.unpushed);
  const offerPr = !blocker && !!pr?.github;

  return (
    <div className="flex-1 min-h-0 flex bg-ctp-base" data-testid="changes-review">
      <div className="w-[300px] flex-shrink-0 border-r border-surface-0 flex flex-col min-h-0">
        <div className="flex-shrink-0 px-3.5 pt-3 pb-2.5 flex flex-col gap-1.5 border-b border-surface-0">
          <div className="flex items-center gap-[7px] text-[13px] font-semibold text-ctp-text min-w-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="flex-shrink-0 text-ctp-overlay1">
              <circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-6 4-12 8" />
            </svg>
            <span className="truncate font-mono text-[12px]" data-testid="review-branch">{branch?.branch ?? info?.branch ?? '…'}</span>
          </div>
          <div className="text-xs text-ctp-overlay1" data-testid="review-ahead">
            {root ? 'Project root' : branch?.noBase ? 'No main or master branch to compare with' : `${ahead} ${ahead === 1 ? 'commit' : 'commits'} ahead of ${base}`}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto pt-1 flex flex-col">
          <Section
            title="Uncommitted"
            count={uncommitted.length}
            right={uncommitted.length > stagedCount ? (
              <button type="button" className="text-ctp-accent hover:underline" onClick={() => { void run('stage', () => window.clubhouse.git.stageAll(cwd)); }} disabled={busy !== null}>Stage all</button>
            ) : undefined}
          >
            {uncommitted.length === 0 ? (
              <p className="px-3.5 pb-1.5 text-xs text-ctp-overlay1">Nothing uncommitted.</p>
            ) : (
              <ul className="flex flex-col">
                {uncommitted.map((f) => (
                  <li key={f.path} className="h-7 flex items-center gap-[7px] pl-3.5 pr-2.5 mx-1.5 rounded-md hover:bg-surface-0">
                    <input
                      type="checkbox"
                      checked={f.staged}
                      onChange={() => { void toggleStage({ path: f.path, status: '', staged: f.staged }); }}
                      aria-label={`${f.staged ? 'Unstage' : 'Stage'} ${f.path}`}
                      className="accent-ctp-accent"
                      data-testid="review-stage"
                    />
                    <span className={`flex-shrink-0 w-2.5 font-mono text-[11px] font-semibold ${STATUS_TONE[f.status]}`}>{f.untracked ? 'U' : STATUS_LETTER[f.status]}</span>
                    <span className="text-[12.5px] text-ctp-text whitespace-nowrap">{f.path.split('/').pop()}</span>
                    <span className="min-w-0 truncate text-xs text-ctp-overlay1">{f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="px-3.5"><Result result={results.stage ?? null} /></div>
            {uncommitted.length > 0 && (
              <div className="mx-3.5 mt-2 mb-1 flex flex-col gap-1.5">
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Commit message"
                  aria-label="Commit message"
                  rows={2}
                  className="resize-none rounded-md border border-surface-1 bg-ctp-crust px-2.5 py-1.5 text-xs text-ctp-text placeholder:text-ctp-overlay0 focus:outline-none focus:border-ctp-accent/60"
                  data-testid="review-commit-message"
                />
                <div className="flex gap-1.5">
                  <Button
                    kind="primary"
                    className="flex-1"
                    disabled={stagedCount === 0 || !message.trim() || busy !== null}
                    onClick={() => { void run('commit', () => window.clubhouse.git.commit(cwd, message.trim()), (r) => { if (r.ok) setMessage(''); }); }}
                    data-testid="review-commit"
                  >
                    {stagedCount === 0 ? 'Stage files to commit' : `Commit ${stagedCount} ${stagedCount === 1 ? 'file' : 'files'}`}
                  </Button>
                  {onAskAgent && (
                    <Button
                      kind="ghost"
                      onClick={() => onAskAgent(message.trim()
                        ? `Commit the staged changes with this message: ${message.trim()}`
                        : 'Commit your changes on this branch with a clear message.')}
                      data-testid="review-ask-agent"
                    >
                      Ask {agentName}
                    </Button>
                  )}
                </div>
                <Result result={results.commit ?? null} />
              </div>
            )}
          </Section>

          {!root && <div className="h-px bg-surface-0 mx-3.5 my-2 flex-shrink-0" />}

          {!root && <Section title="Commits on this branch" count={log?.length ?? 0}>
            {(log ?? []).length === 0 ? (
              <p className="px-3.5 pb-1.5 text-xs text-ctp-overlay1">No commits since it left {base}.</p>
            ) : (
              <ul className="flex flex-col">
                {(log ?? []).map((c) => {
                  const sel = focus.kind === 'commit' && focus.hash === c.hash;
                  return (
                    <li key={c.hash}>
                      <button
                        type="button"
                        onClick={() => setFocus(sel ? { kind: 'branch' } : { kind: 'commit', hash: c.hash, subject: c.subject, shortHash: c.shortHash })}
                        aria-pressed={sel}
                        className={`w-[calc(100%-12px)] mx-1.5 flex flex-col items-start py-[5px] pl-3.5 pr-2.5 rounded-md text-left ${sel ? 'bg-surface-0' : 'hover:bg-surface-0'}`}
                        data-testid="review-commit-row"
                      >
                        <span className="text-[12.5px] text-ctp-text truncate w-full">{c.subject}</span>
                        <span className="text-xs text-ctp-overlay1"><span className="font-mono text-[11.5px]">{c.shortHash}</span> · {c.date}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>}
        </div>

        {!root && <div className="flex-shrink-0 border-t border-surface-0 px-3.5 py-2.5 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-ctp-overlay1" data-testid="review-pr-status">{prLine}</div>
          {blocker && <p className="text-xs text-ctp-overlay1" data-testid="review-pr-blocker">{blocker}</p>}
          {!blocker && pr && !pr.github && (
            <p className="text-xs text-ctp-overlay1" data-testid="review-pr-not-github">
              {pr.remote ?? 'This remote'} isn&apos;t on GitHub. Push here, then open the pull request on your git host.
            </p>
          )}
          <div className="flex gap-1.5">
            {offerPr && (
              <Button kind="primary" className="flex-1" disabled={busy !== null} onClick={() => { void openPr(); }} data-testid="review-open-pr">
                {prButton}
              </Button>
            )}
            <Button
              kind={offerPr ? 'ghost' : 'primary'}
              className={offerPr ? '' : 'flex-1'}
              disabled={busy !== null || !canPush}
              onClick={() => { void run('push', () => window.clubhouse.git.pushBranch(cwd)); }}
              data-testid="review-push"
            >
              Push
            </Button>
          </div>
          <Result result={results.pr ?? results.push ?? null} />
        </div>}
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="h-8 flex-shrink-0 flex items-center gap-2.5 pl-4 pr-3 border-b border-surface-0 text-xs text-ctp-overlay1 whitespace-nowrap">
          {focus.kind === 'commit' ? (
            <>
              <span className="font-medium text-ctp-text truncate">{focus.subject}</span>
              <span className="font-mono text-[11.5px]">{focus.shortHash}</span>
              <button type="button" className="ml-auto text-ctp-accent hover:underline" onClick={() => setFocus({ kind: 'branch' })}>Everything on this branch</button>
            </>
          ) : (
            <>
              <span className="inline-flex gap-0.5 p-0.5 rounded-[7px] bg-ctp-crust" role="group" aria-label="Files to review">
                {(['branch', 'uncommitted'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={focus.kind === k}
                    onClick={() => setFocus({ kind: k })}
                    disabled={k === 'uncommitted' && uncommitted.length === 0}
                    className={`h-5 px-[9px] rounded-[5px] text-xs disabled:opacity-40 ${focus.kind === k ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`}
                  >
                    {k === 'branch' ? (root ? 'Agent branches' : `Everything vs ${base}`) : 'Uncommitted'}
                  </button>
                ))}
              </span>
              {!showAside && (added > 0 || removed > 0) && <PlusMinus added={added} removed={removed} />}
              {!showAside && <span className="ml-auto">{shown.length} {shown.length === 1 ? 'file' : 'files'}</span>}
            </>
          )}
        </div>
        {showAside ? <div className="flex-1 min-h-0 overflow-y-auto">{root?.aside}</div> : <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-2.5" data-testid="review-files">
          {shown.length === 0 && (
            <p className="text-xs text-ctp-overlay1">
              {focus.kind === 'uncommitted' ? 'Nothing uncommitted.' : branch && !branch.available ? 'Changes need the agent to work in a git repository.' : `Nothing changed on this branch since it left ${base}.`}
            </p>
          )}
          {shown.map((f) => {
            const unc = focus.kind === 'uncommitted' ? stagedByPath.get(f.path) : undefined;
            return (
              <FileBlock
                key={`${focus.kind}:${focus.kind === 'commit' ? focus.hash : ''}:${f.path}`}
                file={f}
                version={`${String(refreshKey)}:${reloads}:${branch?.mergeBase ?? ''}:${f.additions}/${f.deletions}:${unc?.staged ? 's' : ''}`}
                loadDiff={loader}
                staged={unc ? unc.staged : undefined}
                onDiscard={unc ? async () => {
                  const r = await window.clubhouse.git.discard(cwd, f.path, unc.untracked);
                  refresh();
                  return r;
                } : undefined}
              />
            );
          })}
        </div>}
      </div>
    </div>
  );
}
