import { useEffect, useState, useCallback } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { GitInfo, GitStatusFile } from '../../../shared/types';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modified', color: 'text-yellow-300' },
  'A': { label: 'Added', color: 'text-green-300' },
  'D': { label: 'Deleted', color: 'text-red-300' },
  '??': { label: 'Untracked', color: 'text-ctp-subtext0' },
  'R': { label: 'Renamed', color: 'text-blue-300' },
  'C': { label: 'Copied', color: 'text-blue-300' },
  'UU': { label: 'Conflict', color: 'text-red-400' },
  'AA': { label: 'Both Added', color: 'text-red-400' },
  'DD': { label: 'Both Deleted', color: 'text-red-400' },
  'AU': { label: 'Conflict', color: 'text-red-400' },
  'UA': { label: 'Conflict', color: 'text-red-400' },
  'DU': { label: 'Conflict', color: 'text-red-400' },
  'UD': { label: 'Conflict', color: 'text-red-400' },
};

function StatusIcon({ status }: { status: string }) {
  const info = STATUS_LABELS[status] || { label: status, color: 'text-ctp-subtext0' };
  return (
    <span className={`text-xs font-mono w-5 text-center ${info.color}`} title={info.label}>
      {status}
    </span>
  );
}

function FileDisplay({ file }: { file: GitStatusFile }) {
  if (file.origPath) {
    return (
      <span className="flex-1 text-xs text-ctp-text truncate" title={`${file.origPath} \u2192 ${file.path}`}>
        {file.path} <span className="text-ctp-subtext0">{'\u2190'} {file.origPath}</span>
      </span>
    );
  }
  return <span className="flex-1 text-xs text-ctp-text truncate">{file.path}</span>;
}

interface WorktreeSectionProps {
  dirPath: string;
  label: string;
  defaultExpanded: boolean;
  icon: React.ReactNode;
}

export function WorktreeSection({ dirPath, label, defaultExpanded, icon }: WorktreeSectionProps) {
  const { setSelectedGitFile, setExplorerTab } = useUIStore();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [opStatus, setOpStatus] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [showBranchInput, setShowBranchInput] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const info = await window.clubhouse.git.info(dirPath);
    setGitInfo(info);
    setLoading(false);
    setLoaded(true);
  }, [dirPath]);

  // Lazy-load: fetch git info only when first expanded
  useEffect(() => {
    if (expanded && !loaded) {
      refresh();
    }
  }, [expanded, loaded, refresh]);

  // Also load immediately if defaultExpanded
  useEffect(() => {
    if (defaultExpanded && !loaded) {
      refresh();
    }
  }, [defaultExpanded, loaded, refresh]);

  // Clear status message after 4s
  useEffect(() => {
    if (!opStatus) return;
    const t = setTimeout(() => setOpStatus(null), 4000);
    return () => clearTimeout(t);
  }, [opStatus]);

  const staged = gitInfo?.status.filter((f) => f.staged) ?? [];
  const unstaged = gitInfo?.status.filter((f) => !f.staged) ?? [];

  const handleStage = async (file: GitStatusFile) => {
    await window.clubhouse.git.stage(dirPath, file.path);
    refresh();
  };

  const handleUnstage = async (file: GitStatusFile) => {
    await window.clubhouse.git.unstage(dirPath, file.path);
    refresh();
  };

  const handleStageAll = async () => {
    await window.clubhouse.git.stageAll(dirPath);
    refresh();
  };

  const handleUnstageAll = async () => {
    await window.clubhouse.git.unstageAll(dirPath);
    refresh();
  };

  const handleDiscard = async (file: GitStatusFile) => {
    const isUntracked = file.status === '??';
    const result = await window.clubhouse.git.discard(dirPath, file.path, isUntracked);
    if (!result.ok) {
      setOpStatus({ type: 'err', msg: result.message });
    }
    setConfirmDiscard(null);
    refresh();
  };

  const handleCommit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    const result = await window.clubhouse.git.commit(dirPath, commitMsg.trim());
    if (result.ok) {
      setCommitMsg('');
      setOpStatus({ type: 'ok', msg: 'Committed' });
    } else {
      setOpStatus({ type: 'err', msg: result.message });
    }
    setCommitting(false);
    refresh();
  };

  const handlePush = async () => {
    setPushing(true);
    const result = await window.clubhouse.git.push(dirPath);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Pushed' : result.message });
    setPushing(false);
    refresh();
  };

  const handlePull = async () => {
    setPulling(true);
    const result = await window.clubhouse.git.pull(dirPath);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Pulled' : result.message });
    setPulling(false);
    refresh();
  };

  const handleSync = async () => {
    setPulling(true);
    const pullResult = await window.clubhouse.git.pull(dirPath);
    setPulling(false);
    if (!pullResult.ok) {
      setOpStatus({ type: 'err', msg: pullResult.message });
      refresh();
      return;
    }
    setPushing(true);
    const pushResult = await window.clubhouse.git.push(dirPath);
    setPushing(false);
    setOpStatus({ type: pushResult.ok ? 'ok' : 'err', msg: pushResult.ok ? 'Synced' : pushResult.message });
    refresh();
  };

  const handleCreateBranch = async () => {
    const name = newBranchName.trim();
    if (!name) return;
    const result = await window.clubhouse.git.createBranch(dirPath, name);
    if (result.ok) {
      setOpStatus({ type: 'ok', msg: `Branch '${name}' created` });
      setNewBranchName('');
      setShowBranchInput(false);
    } else {
      setOpStatus({ type: 'err', msg: result.message });
    }
    refresh();
  };

  const handleStash = async () => {
    const result = await window.clubhouse.git.stash(dirPath);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Stashed' : result.message });
    refresh();
  };

  const handleStashPop = async () => {
    const result = await window.clubhouse.git.stashPop(dirPath);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Stash popped' : result.message });
    refresh();
  };

  const handleOpenTerminal = () => {
    setExplorerTab('terminal');
    // Send cd command to navigate terminal to this worktree's directory
    setTimeout(() => {
      window.clubhouse.pty.write('standalone-terminal', `cd "${dirPath}" && clear\r`);
    }, 300);
  };

  const changeCount = gitInfo ? gitInfo.status.length : 0;

  return (
    <div className="border-b border-surface-0">
      {/* Collapsible header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 hover:bg-surface-0 cursor-pointer text-left"
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`flex-shrink-0 text-ctp-subtext0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        >
          <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {icon}
        <span className="text-sm font-medium text-ctp-text truncate">{label}</span>
        {gitInfo?.branch && (
          <span className="text-xs text-ctp-subtext0 truncate ml-auto">{gitInfo.branch}</span>
        )}
        {changeCount > 0 && (
          <span className="text-[10px] bg-surface-2 text-ctp-subtext1 rounded-full px-1.5 py-0.5 flex-shrink-0">
            {changeCount}
          </span>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); refresh(); }}
          className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1 flex-shrink-0"
          title="Refresh"
        >
          {loading ? '...' : '\u21BB'}
        </button>
      </button>

      {!expanded ? null : !gitInfo ? (
        <div className="px-3 py-2 text-ctp-subtext0 text-xs">
          {loading ? 'Loading...' : 'No git info available'}
        </div>
      ) : !gitInfo.hasGit ? (
        <div className="px-3 py-2 text-ctp-subtext0 text-xs">
          No git repository found.
        </div>
      ) : (
        <div>
          {/* Conflict banner */}
          {gitInfo.hasConflicts && (
            <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20">
              <div className="flex items-center justify-between">
                <span className="text-xs text-red-300 font-medium">Merge conflicts detected</span>
                <button
                  onClick={handleOpenTerminal}
                  className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300
                    hover:bg-red-500/30 transition-colors cursor-pointer"
                >
                  Open in Terminal
                </button>
              </div>
            </div>
          )}

          {/* Ahead/behind + remote actions */}
          <div className="px-3 pb-2">
            {gitInfo.remote && (
              <div className="flex items-center gap-1.5 text-xs text-ctp-subtext0 mb-2">
                {gitInfo.ahead > 0 && <span className="text-green-300">{gitInfo.ahead}{'\u2191'}</span>}
                {gitInfo.behind > 0 && <span className="text-yellow-300">{gitInfo.behind}{'\u2193'}</span>}
                {gitInfo.ahead === 0 && gitInfo.behind === 0 && <span>Up to date</span>}
              </div>
            )}

            {/* Push / Pull / Sync */}
            <div className="flex gap-1.5">
              <button
                onClick={handlePull}
                disabled={pulling || !gitInfo.remote}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pulling ? '...' : '\u2193 Pull'}
              </button>
              <button
                onClick={handlePush}
                disabled={pushing || !gitInfo.remote}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pushing ? '...' : '\u2191 Push'}
              </button>
              <button
                onClick={handleSync}
                disabled={pushing || pulling || !gitInfo.remote}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pushing || pulling ? '...' : '\u21C5 Sync'}
              </button>
            </div>

            {/* Stash / Branch row */}
            <div className="flex gap-1.5 mt-1.5">
              <button
                onClick={handleStash}
                disabled={changeCount === 0}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
                title="Stash changes"
              >
                Stash
              </button>
              <button
                onClick={handleStashPop}
                disabled={!gitInfo.stashCount}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
                title={gitInfo.stashCount ? `Pop stash (${gitInfo.stashCount})` : 'No stashes'}
              >
                Pop{gitInfo.stashCount ? ` (${gitInfo.stashCount})` : ''}
              </button>
              <button
                onClick={() => setShowBranchInput(!showBranchInput)}
                className="flex-1 px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 hover:text-ctp-text transition-colors cursor-pointer"
                title="Create new branch"
              >
                + Branch
              </button>
            </div>

            {/* New branch input */}
            {showBranchInput && (
              <div className="flex gap-1.5 mt-1.5">
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  placeholder="branch-name"
                  className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-xs text-ctp-text
                    placeholder-ctp-subtext0 focus:outline-none focus:border-indigo-500"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateBranch();
                    if (e.key === 'Escape') { setShowBranchInput(false); setNewBranchName(''); }
                  }}
                  autoFocus
                />
                <button
                  onClick={handleCreateBranch}
                  disabled={!newBranchName.trim()}
                  className="px-2 py-1 text-xs rounded bg-indigo-500/20 text-indigo-300
                    hover:bg-indigo-500/30 transition-colors cursor-pointer
                    disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Create
                </button>
              </div>
            )}
          </div>

          {/* Status message */}
          {opStatus && (
            <div className={`px-3 py-1.5 text-xs ${
              opStatus.type === 'ok' ? 'text-green-300 bg-green-500/10' : 'text-red-300 bg-red-500/10'
            }`}>
              {opStatus.msg}
            </div>
          )}

          {/* Commit box */}
          {staged.length > 0 && (
            <div className="px-3 py-2">
              <textarea
                value={commitMsg}
                onChange={(e) => setCommitMsg(e.target.value)}
                placeholder="Commit message..."
                className="w-full bg-surface-0 border border-surface-2 rounded px-2 py-1.5 text-xs text-ctp-text
                  placeholder-ctp-subtext0 resize-none focus:outline-none focus:border-indigo-500"
                rows={2}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    handleCommit();
                  }
                }}
              />
              <button
                onClick={handleCommit}
                disabled={!commitMsg.trim() || committing}
                className="mt-1.5 w-full px-2 py-1.5 text-xs rounded bg-indigo-500/20 text-indigo-300
                  hover:bg-indigo-500/30 transition-colors cursor-pointer
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {committing ? 'Committing...' : `Commit (${staged.length} file${staged.length !== 1 ? 's' : ''})`}
              </button>
            </div>
          )}

          {/* Staged changes */}
          {staged.length > 0 && (
            <div>
              <div className="flex items-center px-3 py-1.5">
                <span className="text-xs font-semibold text-green-300 uppercase tracking-wider flex-1">
                  Staged ({staged.length})
                </span>
                <button
                  onClick={handleUnstageAll}
                  className="text-[10px] text-ctp-subtext0 hover:text-yellow-300 cursor-pointer px-1"
                  title="Unstage all"
                >
                  Unstage All
                </button>
              </div>
              {staged.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center gap-2 px-3 py-1 hover:bg-surface-0 cursor-pointer group"
                  onClick={() => setSelectedGitFile({ path: f.path, staged: f.staged, worktreePath: dirPath })}
                >
                  <StatusIcon status={f.status} />
                  <FileDisplay file={f} />
                  <button
                    onClick={(e) => { e.stopPropagation(); handleUnstage(f); }}
                    className="text-xs text-ctp-subtext0 hover:text-red-300 opacity-0 group-hover:opacity-100 cursor-pointer"
                    title="Unstage"
                  >
                    -
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Unstaged / untracked */}
          {unstaged.length > 0 && (
            <div>
              <div className="flex items-center px-3 py-1.5">
                <span className="text-xs font-semibold text-yellow-300 uppercase tracking-wider flex-1">
                  Changes ({unstaged.length})
                </span>
                <button
                  onClick={handleStageAll}
                  className="text-[10px] text-ctp-subtext0 hover:text-green-300 cursor-pointer px-1"
                  title="Stage all"
                >
                  Stage All
                </button>
              </div>
              {unstaged.map((f) => (
                <div
                  key={f.path}
                  className="flex items-center gap-2 px-3 py-1 hover:bg-surface-0 cursor-pointer group"
                  onClick={() => setSelectedGitFile({ path: f.path, staged: f.staged, worktreePath: dirPath })}
                >
                  <StatusIcon status={f.status} />
                  <FileDisplay file={f} />
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100">
                    {confirmDiscard === f.path ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDiscard(f); }}
                          className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer"
                          title="Confirm discard"
                        >
                          Yes
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDiscard(null); }}
                          className="text-[10px] text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
                        >
                          No
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setConfirmDiscard(f.path); }}
                          className="text-xs text-ctp-subtext0 hover:text-red-300 cursor-pointer"
                          title="Discard changes"
                        >
                          {'\u2715'}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStage(f); }}
                          className="text-xs text-ctp-subtext0 hover:text-green-300 cursor-pointer"
                          title="Stage"
                        >
                          +
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {staged.length === 0 && unstaged.length === 0 && (
            <div className="px-3 py-2 text-xs text-ctp-subtext0">
              Working tree clean
            </div>
          )}
        </div>
      )}
    </div>
  );
}
