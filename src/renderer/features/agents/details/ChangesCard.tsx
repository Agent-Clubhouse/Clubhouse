/**
 * The Changes card in Agent details (#2032). It folds in the old Changes
 * panel: the branch against main for every agent, plus the session and the
 * last turn from Clubhouse's checkpoints for chat agents, with Revert last
 * turn. A file opens in place to its diff.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangedFile, ChangesResult, CheckpointTurn, RevertResult } from '../../../../shared/chat-checkpoints';
import type { BranchChanges } from '../../../../shared/git-branch';
import { Button } from '../../../components/Button';
import { DiffCard } from '../chat/ToolBlocks';
import { CardNote, DetailsCard, PlusMinus } from './DetailsCard';

export type ChangesScope = 'branch' | 'session' | 'turn';

const STATUS_LETTER: Record<ChangedFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const STATUS_TONE: Record<ChangedFile['status'], string> = {
  added: 'text-ctp-success', modified: 'text-ctp-warning', deleted: 'text-ctp-error', renamed: 'text-ctp-info',
};

export function totals(files: ChangedFile[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.additions, removed: t.removed + f.deletions }), { added: 0, removed: 0 });
}

/** "6 files +94 −51", the card's one-line answer. */
export function ChangesSummary({ files }: { files: ChangedFile[] }) {
  if (files.length === 0) return <>no changes</>;
  const { added, removed } = totals(files);
  return <>{files.length} {files.length === 1 ? 'file' : 'files'} <PlusMinus added={added} removed={removed} /></>;
}

/** Five cells of green and red, like a pull request's diffstat. */
function DiffBar({ added, removed }: { added: number; removed: number }) {
  const n = added + removed || 1;
  const g = Math.round((5 * added) / n);
  const r = Math.min(5 - g, Math.round((5 * removed) / n));
  return (
    <span className="flex-shrink-0 inline-flex gap-px" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={`w-1.5 h-1.5 rounded-[1px] ${i < g ? 'bg-ctp-success' : i < g + r ? 'bg-ctp-error' : 'bg-surface-1'}`} />
      ))}
    </span>
  );
}

type Diff = Parameters<typeof DiffCard>[0]['diff'];

/** Files as rows; clicking one opens its diff under it. */
/** A diff, or why there's none: too large to read, or nothing to show. */
type DiffResult = Diff | 'tooLarge' | { link: string } | null;

function FileList({ files, loadDiff, max }: { files: ChangedFile[]; loadDiff: (path: string) => Promise<DiffResult>; max?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<DiffResult | 'loading' | 'failed'>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!open) { setDiff(null); return; }
    let cancelled = false;
    setDiff('loading');
    loadDiff(open).then(
      (d) => { if (!cancelled) setDiff(d ?? 'failed'); },
      () => { if (!cancelled) setDiff('failed'); },
    );
    return () => { cancelled = true; };
  }, [open, loadDiff]);

  const shown = max && !showAll ? files.slice(0, max) : files;
  return (
    <ul className="flex flex-col" data-testid="chat-changes-files">
      {shown.map((f) => {
        const slash = f.path.lastIndexOf('/');
        const name = f.path.slice(slash + 1);
        const dir = slash > 0 ? f.path.slice(0, slash) : '';
        const isOpen = open === f.path;
        return (
          <li key={f.path} className="flex flex-col">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : f.path)}
              aria-expanded={isOpen}
              title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              data-testid="changes-file-row"
              data-path={f.path}
              className={`h-7 flex items-center gap-[7px] pl-3 pr-2.5 ml-[22px] mr-1.5 rounded-md text-left ${isOpen ? 'bg-surface-0' : 'hover:bg-surface-0'}`}
            >
              <span className={`flex-shrink-0 w-2.5 font-mono text-[11px] font-semibold ${STATUS_TONE[f.status]}`}>{STATUS_LETTER[f.status]}</span>
              <span className="flex-shrink-0 text-[12.5px] text-ctp-text whitespace-nowrap">{name}</span>
              <span className="min-w-0 truncate text-xs text-ctp-overlay1">{dir}</span>
              <span className="ml-auto flex-shrink-0 flex items-center gap-2">
                {f.binary ? <span className="text-xs text-ctp-overlay0">binary</span> : <><PlusMinus added={f.additions} removed={f.deletions} /><DiffBar added={f.additions} removed={f.deletions} /></>}
              </span>
            </button>
            {isOpen && (
              <div className="mt-0.5 mb-2 ml-7 mr-2.5" data-testid="changes-file-diff">
                {diff === 'loading' && <p className="text-xs text-ctp-overlay1 py-1">Loading…</p>}
                {diff === 'failed' && <p className="text-xs text-ctp-overlay1 py-1">No diff to show for this file.</p>}
                {diff === 'tooLarge' && <p className="text-xs text-ctp-overlay1 py-1">Too large to show here (over 1 MB).</p>}
                {diff && typeof diff === 'object' && 'link' in diff && (
                  <p className="text-xs text-ctp-overlay1 py-1">Symbolic link to <span className="font-mono text-[11.5px] text-ctp-text break-all">{diff.link || 'an unreadable target'}</span></p>
                )}
                {diff && typeof diff === 'object' && 'type' in diff && <DiffCard diff={diff} />}
              </div>
            )}
          </li>
        );
      })}
      {shown.length < files.length && (
        <li>
          <button type="button" onClick={() => setShowAll(true)} className="h-[26px] pl-[54px] text-xs text-ctp-overlay1 hover:text-ctp-text">
            {files.length - shown.length} more {files.length - shown.length === 1 ? 'file' : 'files'}
          </button>
        </li>
      )}
    </ul>
  );
}

/** The branch against its merge base with main. */
function BranchBody({ cwd, changes }: { cwd: string; changes: BranchChanges | null }) {
  const loadDiff = useCallback(async (p: string): Promise<DiffResult> => {
    const r = await window.clubhouse.git.branchFilePatch(cwd, p, undefined);
    if (r.tooLarge) return 'tooLarge';
    if (r.link !== undefined) return { link: r.link };
    if (r.binary) return null;
    if (r.patch) return { type: 'diff', path: p, unifiedDiff: r.patch };
    if (r.newText !== undefined) return { type: 'diff', path: p, newText: r.newText };
    return null;
  }, [cwd]);
  if (!changes) return <CardNote>Loading…</CardNote>;
  if (!changes.available) return <CardNote>Changes need the agent to work in a git repository.</CardNote>;
  if (changes.noBase) return <CardNote>No main or master branch to compare with.</CardNote>;
  if (changes.files.length === 0) return <CardNote>Nothing changed on this branch yet.</CardNote>;
  return <FileList files={changes.files} loadDiff={loadDiff} max={8} />;
}

type Confirm = 'revert' | 'force' | null;
type Outcome = { kind: 'revert' | 'undo'; result: RevertResult };

/**
 * The session or the last turn, from Clubhouse's checkpoints, with Revert last
 * turn and its confirmations (moved from the old Changes panel).
 */
export function CheckpointChanges({ agentId, sessionId, refreshKey, scope }: {
  agentId: string;
  sessionId: string | null;
  refreshKey: string;
  scope: 'session' | 'turn';
}) {
  const [turns, setTurns] = useState<CheckpointTurn[]>([]);
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lastTurn = turns.length ? turns[turns.length - 1] : undefined;
  const target = useMemo(() => {
    if (scope === 'session') return sessionId ? { sessionId } : null;
    return lastTurn ? { turnId: lastTurn.turnId } : null;
  }, [scope, sessionId, lastTurn]);

  const load = useCallback(async () => {
    setError(null);
    try {
      setTurns(await window.clubhouse.chat.listCheckpoints(agentId));
    } catch (err) {
      // telemetry-exempt: shown in the card; chat stays independent of telemetry (research §7.3).
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load, refreshKey]);
  useEffect(() => { setOutcome(null); setConfirm(null); }, [scope]);

  useEffect(() => {
    if (!target) { setChanges(null); return; }
    let cancelled = false;
    void window.clubhouse.chat.getChanges(agentId, target).then(
      (result) => { if (!cancelled) setChanges(result); },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [agentId, target, refreshKey]);

  const loadDiff = useCallback(async (p: string): Promise<DiffResult> => {
    if (!target) return null;
    const r = await window.clubhouse.chat.getChanges(agentId, target, p);
    return r.patch ? { type: 'diff', path: p, unifiedDiff: r.patch } : null;
  }, [agentId, target]);

  // A new turn makes the previous result and confirmation stale.
  const lastTurnId = lastTurn?.turnId;
  useEffect(() => { setOutcome(null); setConfirm(null); }, [lastTurnId]);

  const run = async (kind: Outcome['kind'], force = false) => {
    if (!lastTurn) return;
    setBusy(true);
    setError(null);
    try {
      const result = kind === 'undo'
        ? await window.clubhouse.chat.undoRevert(agentId, lastTurn.turnId)
        : await window.clubhouse.chat.revertTurn(agentId, lastTurn.turnId, force);
      setOutcome({ kind, result });
      setConfirm(null);
      await load();
      setChanges(await window.clubhouse.chat.getChanges(agentId, { turnId: lastTurn.turnId }));
    } catch (err) {
      // telemetry-exempt: shown in the card; chat stays independent of telemetry (research §7.3).
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const files = changes?.files ?? [];
  const canRevert = scope === 'turn' && !!lastTurn?.end && files.length > 0;
  const result = outcome?.result;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <>
      {changes && !changes.available && <CardNote>Changes need the agent to work in a git repository.</CardNote>}
      {changes?.available && files.length === 0 && (
        <CardNote><span data-testid="chat-changes-empty">{scope === 'turn' ? 'No file changes in the last turn.' : 'No file changes in this session yet.'}</span></CardNote>
      )}
      {!changes && !error && <CardNote>No turns recorded yet.</CardNote>}
      {files.length > 0 && <FileList files={files} loadDiff={loadDiff} max={8} />}
      <div className="pr-3.5 pl-[33px] pt-1.5 flex flex-col gap-2 text-xs">
        {changes?.live && scope === 'turn' && <p className="text-ctp-overlay1">This turn is still running; showing changes so far.</p>}
        {changes?.skippedLarge?.length ? (
          <p className="text-ctp-overlay1" data-testid="chat-changes-skipped-large">
            Not tracked (over 10 MB, untracked): {changes.skippedLarge.join(', ')}. Revert leaves them alone.
          </p>
        ) : null}
        {changes?.skippedRepos?.length ? (
          <p className="text-ctp-overlay1" data-testid="chat-changes-skipped-repos">
            Not tracked (git repositories with no commits yet): {changes.skippedRepos.join(', ')}. Revert leaves them alone.
          </p>
        ) : null}
        {result && (
          <div className="text-ctp-subtext0 flex flex-col gap-1" data-testid="chat-changes-revert-result">
            <span>
              {outcome?.kind === 'undo'
                ? `Undid the revert: restored ${plural(result.reverted.length, 'file', 'files')}.`
                : `Reverted ${plural(result.reverted.length, 'file', 'files')}.`}
            </span>
            {result.conflicts.length > 0 && (
              <span>
                {outcome?.kind === 'undo'
                  ? `${plural(result.conflicts.length, 'file', 'files')} changed after the revert and ${result.conflicts.length === 1 ? 'was' : 'were'} left alone: `
                  : `${plural(result.conflicts.length, 'file', 'files')} changed after the turn and ${result.conflicts.length === 1 ? 'was' : 'were'} left alone: `}
                {result.conflicts.join(', ')}.{' '}
                {outcome?.kind === 'revert' && confirm !== 'force' && (
                  <button type="button" className="underline text-ctp-warning" onClick={() => setConfirm('force')} disabled={busy}>Overwrite those too…</button>
                )}
              </span>
            )}
            {result.skipped.length > 0 && (
              <span data-testid="chat-changes-revert-skipped">
                {plural(result.skipped.length, 'file was', 'files were')} left alone because {result.skipped.length === 1 ? 'its' : 'their'} current state can&apos;t be backed up (large, ignored, a folder or behind a link): {result.skipped.join(', ')}.
              </span>
            )}
          </div>
        )}
        {error && <p className="text-ctp-error" role="alert">{error}</p>}
        {confirm === 'revert' && (
          <div className="flex flex-col gap-2 text-ctp-subtext0" data-testid="chat-changes-confirm">
            <span>Restore {plural(files.length, 'file', 'files')} to before the last turn? Current versions are backed up first, so you can undo.</span>
            {lastTurn?.shared && (
              <span className="text-ctp-warning" data-testid="chat-changes-shared-warning">
                Another agent was working in this folder during this turn. Its edits to these files are reverted too.
              </span>
            )}
            <span className="flex items-center gap-2">
              <Button kind="danger-solid" disabled={busy} onClick={() => { void run('revert'); }}>Revert</Button>
              <Button kind="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            </span>
          </div>
        )}
        {confirm === 'force' && result && (
          <div className="flex flex-col gap-2 text-ctp-subtext0" data-testid="chat-changes-force-confirm">
            <span>
              Overwrite {plural(result.conflicts.length, 'file', 'files')} changed after the turn, by you or something else? Their current versions are backed up first; Undo revert brings them back.
            </span>
            <span className="flex items-center gap-2">
              <Button kind="danger-solid" disabled={busy} onClick={() => { void run('revert', true); }}>Overwrite</Button>
              <Button kind="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            </span>
          </div>
        )}
        {confirm === null && scope === 'turn' && (
          <span className="flex items-center gap-1.5">
            <Button
              kind="quiet"
              disabled={!canRevert || busy}
              onClick={() => { setOutcome(null); setConfirm('revert'); }}
              title={!lastTurn?.end ? 'Available when the turn finishes' : undefined}
            >
              Revert last turn…
            </Button>
            {lastTurn?.undoable && (
              <Button kind="quiet" disabled={busy} onClick={() => { void run('undo'); }}>Undo revert</Button>
            )}
          </span>
        )}
      </div>
    </>
  );
}

const SCOPE_LABEL: Record<ChangesScope, string> = { branch: 'Branch', session: 'Session', turn: 'Last turn' };

export function ChangesCard({ open, onToggle, cwd, branch, chat, agentId, scope, onScope, onReviewAll }: {
  open: boolean;
  onToggle: () => void;
  /** The agent's folder, for the branch view; absent for remote agents. */
  cwd?: string;
  branch: BranchChanges | null;
  /** The chat session, when the agent runs in chat: offers Session and Last turn. */
  chat?: { sessionId: string | null; refreshKey: string };
  agentId: string;
  scope: ChangesScope;
  onScope: (scope: ChangesScope) => void;
  /** Opens the full Changes review (#2032 part 2). Omitted hides the button. */
  onReviewAll?: () => void;
}) {
  const scopes: ChangesScope[] = chat ? ['branch', 'session', 'turn'] : ['branch'];
  const summary = !cwd ? 'not available here' : branch?.available === false ? 'not a git repository' : branch ? <ChangesSummary files={branch.files} /> : '';
  return (
    <DetailsCard id="changes" title="Changes" summary={summary} open={open} onToggle={onToggle}>
      {cwd || chat ? (
        <>
          <div className="flex items-center gap-2 pr-3.5 pl-[33px] pt-0.5 pb-1.5">
            <span className="inline-flex gap-0.5 p-0.5 rounded-[7px] bg-ctp-crust" role="group" aria-label="Changes scope">
              {scopes.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => onScope(s)}
                  className={`h-5 px-[9px] rounded-[5px] text-xs ${scope === s ? 'bg-surface-0 text-ctp-text' : 'text-ctp-subtext0 hover:text-ctp-text'}`}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </span>
            {scope === 'branch' && branch?.base && <span className="text-xs text-ctp-overlay1 whitespace-nowrap">vs {branch.base}</span>}
          </div>
          {scope === 'branch'
            ? (cwd ? <BranchBody cwd={cwd} changes={branch} /> : <CardNote>The branch view needs the agent&apos;s folder on this machine.</CardNote>)
            : chat && <CheckpointChanges agentId={agentId} sessionId={chat.sessionId} refreshKey={chat.refreshKey} scope={scope} />}
          {onReviewAll && scope === 'branch' && (branch?.files.length ?? 0) > 0 && (
            <div className="pr-3.5 pl-[33px] pt-1.5">
              <Button kind="ghost" onClick={onReviewAll} data-testid="details-review-all">Review all</Button>
            </div>
          )}
        </>
      ) : (
        <CardNote>Changes for agents on another machine aren&apos;t available here yet.</CardNote>
      )}
    </DetailsCard>
  );
}
