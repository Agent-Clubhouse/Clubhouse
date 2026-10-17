/**
 * Changes panel (docs/structured-chat-research.md, Phase 4 "Depth"): what the
 * agent changed in its last turn or the whole session, from Clubhouse-owned
 * git checkpoints, with a per-turn revert that works the same for every
 * provider.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangedFile, ChangesResult, CheckpointTurn, RevertResult } from '../../../../shared/chat-checkpoints';
import { DiffCard } from './ToolBlocks';
import { FileIcon, XIcon } from './icons';

type Scope = 'turn' | 'session';
/** Which in-page confirmation is showing: the revert itself, or overwriting files edited after the turn. */
type Confirm = 'revert' | 'force' | null;
type Outcome = { kind: 'revert' | 'undo'; result: RevertResult };

export interface ChangesPanelProps {
  agentId: string;
  /** Current chat session, for the session view. */
  sessionId: string | null;
  /** Changes when a turn starts or ends, prompting a refresh. */
  refreshKey: string;
  onClose: () => void;
}

const STATUS_LABEL: Record<ChangedFile['status'], string> = {
  added: 'A', modified: 'M', deleted: 'D', renamed: 'R',
};

function totals(files: ChangedFile[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.additions, removed: t.removed + f.deletions }), { added: 0, removed: 0 });
}

export function ChangesPanel({ agentId, sessionId, refreshKey, onClose }: ChangesPanelProps) {
  const [scope, setScope] = useState<Scope>('turn');
  const [turns, setTurns] = useState<CheckpointTurn[]>([]);
  const [changes, setChanges] = useState<ChangesResult | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
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
      const list = await window.clubhouse.chat.listCheckpoints(agentId);
      setTurns(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [agentId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => {
    if (!target) { setChanges(null); return; }
    let cancelled = false;
    void window.clubhouse.chat.getChanges(agentId, target).then(
      (result) => {
        if (cancelled) return;
        setChanges(result);
        setSelected((prev) => (prev && result.files.some((f) => f.path === prev) ? prev : result.files[0]?.path ?? null));
      },
      (err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [agentId, target, refreshKey]);

  useEffect(() => {
    if (!target || !selected) { setPatch(null); return; }
    let cancelled = false;
    void window.clubhouse.chat.getChanges(agentId, target, selected).then(
      (result) => { if (!cancelled) setPatch(result.patch ?? ''); },
      () => { if (!cancelled) setPatch(null); },
    );
    return () => { cancelled = true; };
  }, [agentId, target, selected, refreshKey]);

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
      const refreshed = await window.clubhouse.chat.getChanges(agentId, { turnId: lastTurn.turnId });
      setChanges(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const files = changes?.files ?? [];
  const { added, removed } = totals(files);
  const canRevert = scope === 'turn' && !!lastTurn?.end && files.length > 0;
  const result = outcome?.result;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

  return (
    <aside className="w-[400px] flex-shrink-0 border-l border-surface-0 bg-ctp-mantle flex flex-col min-h-0" data-testid="chat-changes-panel">
      <div className="h-[42px] flex-shrink-0 flex items-center gap-2.5 px-3.5 border-b border-surface-0">
        <span className="font-semibold text-[13px] text-ctp-text">Changes</span>
        <span className="inline-flex bg-surface-0 rounded-md p-0.5 text-[11px]" role="group" aria-label="Changes scope">
          {(['turn', 'session'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={scope === s}
              onClick={() => { setScope(s); setOutcome(null); setConfirm(null); }}
              className={`px-2 py-0.5 rounded ${scope === s ? 'bg-ctp-base text-ctp-text' : 'text-ctp-overlay1'}`}
            >
              {s === 'turn' ? 'Last turn' : 'Session'}
            </button>
          ))}
        </span>
        {files.length > 0 && (
          <span className="font-mono text-[11.5px] text-ctp-overlay0" data-testid="chat-changes-totals">
            <span className="text-ctp-green">+{added}</span> <span className="text-ctp-red">−{removed}</span>
          </span>
        )}
        <button type="button" onClick={onClose} className="ml-auto text-ctp-overlay1 hover:text-ctp-text" aria-label="Close changes">
          <XIcon size={14} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {changes && !changes.available && (
          <p className="p-4 text-[12.5px] text-ctp-subtext0">Changes need the agent to work in a git repository.</p>
        )}
        {changes?.available && files.length === 0 && (
          <p className="p-4 text-[12.5px] text-ctp-subtext0" data-testid="chat-changes-empty">
            {scope === 'turn' ? 'No file changes in the last turn.' : 'No file changes in this session yet.'}
          </p>
        )}
        {!changes && !error && <p className="p-4 text-[12.5px] text-ctp-subtext0">No turns recorded yet.</p>}
        {files.length > 0 && (
          <ul className="py-1" data-testid="chat-changes-files">
            {files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() => setSelected(f.path)}
                  className={`w-full h-[30px] flex items-center gap-2 px-3.5 text-[12.5px] text-left ${selected === f.path ? 'bg-surface-0' : 'hover:bg-surface-0/50'}`}
                  title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
                >
                  <FileIcon size={14} className="text-ctp-overlay1 flex-shrink-0" />
                  <span className="font-mono text-[10.5px] w-3 text-ctp-overlay1">{STATUS_LABEL[f.status]}</span>
                  <span className="truncate text-ctp-text min-w-0">{f.path}</span>
                  <span className="ml-auto font-mono text-[11px] whitespace-nowrap">
                    {f.binary ? <span className="text-ctp-overlay0">binary</span> : <><span className="text-ctp-green">+{f.additions}</span> <span className="text-ctp-red">−{f.deletions}</span></>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && patch && (
          <div className="px-3 pb-3">
            <DiffCard diff={{ type: 'diff', path: selected, unifiedDiff: patch }} />
          </div>
        )}
      </div>

      <div className="flex-shrink-0 border-t border-surface-0 p-3 flex flex-col gap-2">
        {changes?.live && scope === 'turn' && (
          <p className="text-[11.5px] text-ctp-overlay1">This turn is still running; showing changes so far.</p>
        )}
        {changes?.skippedLarge?.length ? (
          <p className="text-[11.5px] text-ctp-overlay1" data-testid="chat-changes-skipped-large">
            Not tracked (over 10 MB, untracked): {changes.skippedLarge.join(', ')}. Revert leaves them alone.
          </p>
        ) : null}
        {changes?.skippedRepos?.length ? (
          <p className="text-[11.5px] text-ctp-overlay1" data-testid="chat-changes-skipped-repos">
            Not tracked (git repositories with no commits yet): {changes.skippedRepos.join(', ')}. Revert leaves them alone.
          </p>
        ) : null}
        {result && (
          <div className="text-[12px] text-ctp-subtext0 flex flex-col gap-1" data-testid="chat-changes-revert-result">
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
                  <button type="button" className="underline text-ctp-peach" onClick={() => setConfirm('force')} disabled={busy}>Overwrite those too…</button>
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
        {error && <p className="text-[12px] text-ctp-red" role="alert">{error}</p>}
        {confirm === 'revert' && (
          <div className="flex flex-col gap-2 text-[12px] text-ctp-subtext0" data-testid="chat-changes-confirm">
            <span>Restore {plural(files.length, 'file', 'files')} to before the last turn? Current versions are backed up first, so you can undo.</span>
            {lastTurn?.shared && (
              <span className="text-ctp-peach" data-testid="chat-changes-shared-warning">
                Another agent was working in this folder during this turn. Its edits to these files are reverted too.
              </span>
            )}
            <span className="flex items-center gap-2">
              <button type="button" className="h-7 px-2.5 rounded-md bg-ctp-red text-ctp-crust font-medium" disabled={busy} onClick={() => { void run('revert'); }}>Revert</button>
              <button type="button" className="h-7 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1" onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          </div>
        )}
        {confirm === 'force' && result && (
          <div className="flex flex-col gap-2 text-[12px] text-ctp-subtext0" data-testid="chat-changes-force-confirm">
            <span>
              Overwrite {plural(result.conflicts.length, 'file', 'files')} changed after the turn, by you or something else? Their current versions are backed up first; Undo revert brings them back.
            </span>
            <span className="flex items-center gap-2">
              <button type="button" className="h-7 px-2.5 rounded-md bg-ctp-red text-ctp-crust font-medium" disabled={busy} onClick={() => { void run('revert', true); }}>Overwrite</button>
              <button type="button" className="h-7 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1" onClick={() => setConfirm(null)}>Cancel</button>
            </span>
          </div>
        )}
        {confirm === null && (
          <span className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canRevert || busy}
              onClick={() => { setOutcome(null); setConfirm('revert'); }}
              className="h-7 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] font-medium disabled:opacity-40"
              title={scope === 'session' ? 'Revert works one turn at a time' : !lastTurn?.end ? 'Available when the turn finishes' : undefined}
            >
              Revert last turn
            </button>
            {scope === 'turn' && lastTurn?.undoable && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { void run('undo'); }}
                className="h-7 px-2.5 rounded-md bg-surface-0 text-ctp-subtext1 text-[12px] font-medium disabled:opacity-40"
              >
                Undo revert
              </button>
            )}
          </span>
        )}
      </div>
    </aside>
  );
}
