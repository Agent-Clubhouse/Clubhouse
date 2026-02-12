import { useEffect, useState, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useUIStore } from '../../stores/uiStore';
import { GitInfo, GitStatusFile } from '../../../shared/types';

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  'M': { label: 'Modified', color: 'text-yellow-300' },
  'A': { label: 'Added', color: 'text-green-300' },
  'D': { label: 'Deleted', color: 'text-red-300' },
  '??': { label: 'Untracked', color: 'text-ctp-subtext0' },
  'R': { label: 'Renamed', color: 'text-blue-300' },
  'C': { label: 'Copied', color: 'text-blue-300' },
};

function StatusIcon({ status }: { status: string }) {
  const info = STATUS_LABELS[status] || { label: status, color: 'text-ctp-subtext0' };
  return (
    <span className={`text-xs font-mono w-5 text-center ${info.color}`} title={info.label}>
      {status}
    </span>
  );
}

export function GitSidebar() {
  const { projects, activeProjectId } = useProjectStore();
  const { selectedGitFile, setSelectedGitFile } = useUIStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [commitMsg, setCommitMsg] = useState('');
  const [opStatus, setOpStatus] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [committing, setCommitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeProject) return;
    setLoading(true);
    const info = await window.clubhouse.git.info(activeProject.path);
    setGitInfo(info);
    setLoading(false);
  }, [activeProject]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Clear status message after 4s
  useEffect(() => {
    if (!opStatus) return;
    const t = setTimeout(() => setOpStatus(null), 4000);
    return () => clearTimeout(t);
  }, [opStatus]);

  if (!activeProject || !gitInfo) {
    return (
      <div className="p-3 text-ctp-subtext0 text-sm">
        {loading ? 'Loading...' : 'No git info available'}
      </div>
    );
  }

  if (!gitInfo.hasGit) {
    return (
      <div className="p-3 text-ctp-subtext0 text-sm">
        No git repository in this project.
      </div>
    );
  }

  const staged = gitInfo.status.filter((f) => f.staged);
  const unstaged = gitInfo.status.filter((f) => !f.staged);

  const handleStage = async (file: GitStatusFile) => {
    await window.clubhouse.git.stage(activeProject.path, file.path);
    refresh();
  };

  const handleUnstage = async (file: GitStatusFile) => {
    await window.clubhouse.git.unstage(activeProject.path, file.path);
    refresh();
  };

  const handleCommit = async () => {
    if (!commitMsg.trim() || staged.length === 0) return;
    setCommitting(true);
    const result = await window.clubhouse.git.commit(activeProject.path, commitMsg.trim());
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
    const result = await window.clubhouse.git.push(activeProject.path);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Pushed' : result.message });
    setPushing(false);
    refresh();
  };

  const handlePull = async () => {
    setPulling(true);
    const result = await window.clubhouse.git.pull(activeProject.path);
    setOpStatus({ type: result.ok ? 'ok' : 'err', msg: result.ok ? 'Pulled' : result.message });
    setPulling(false);
    refresh();
  };

  const handleSync = async () => {
    setPulling(true);
    const pullResult = await window.clubhouse.git.pull(activeProject.path);
    setPulling(false);
    if (!pullResult.ok) {
      setOpStatus({ type: 'err', msg: pullResult.message });
      refresh();
      return;
    }
    setPushing(true);
    const pushResult = await window.clubhouse.git.push(activeProject.path);
    setPushing(false);
    setOpStatus({ type: pushResult.ok ? 'ok' : 'err', msg: pushResult.ok ? 'Synced' : pushResult.message });
    refresh();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Branch + remote actions */}
      <div className="px-3 py-2 border-b border-surface-0">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2 min-w-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span className="text-sm font-medium text-ctp-text truncate">{gitInfo.branch}</span>
          </div>
          <button
            onClick={refresh}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer px-1"
            title="Refresh"
          >
            {loading ? '...' : '\u21BB'}
          </button>
        </div>

        {/* Ahead/behind indicator */}
        {gitInfo.remote && (
          <div className="flex items-center gap-1.5 text-xs text-ctp-subtext0 mb-2">
            {gitInfo.ahead > 0 && <span className="text-green-300">{gitInfo.ahead}\u2191</span>}
            {gitInfo.behind > 0 && <span className="text-yellow-300">{gitInfo.behind}\u2193</span>}
            {gitInfo.ahead === 0 && gitInfo.behind === 0 && <span>Up to date</span>}
          </div>
        )}

        {/* Push / Pull / Sync buttons */}
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
      </div>

      {/* Status message */}
      {opStatus && (
        <div className={`px-3 py-1.5 text-xs border-b border-surface-0 ${
          opStatus.type === 'ok' ? 'text-green-300 bg-green-500/10' : 'text-red-300 bg-red-500/10'
        }`}>
          {opStatus.msg}
        </div>
      )}

      {/* Commit box */}
      {staged.length > 0 && (
        <div className="px-3 py-2 border-b border-surface-0">
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

      <div className="flex-1 overflow-y-auto">
        {/* Staged changes */}
        {staged.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-green-300 uppercase tracking-wider">
              Staged ({staged.length})
            </div>
            {staged.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-2 px-3 py-1 hover:bg-surface-0 cursor-pointer group"
                onClick={() => setSelectedGitFile({ path: f.path, staged: f.staged })}
              >
                <StatusIcon status={f.status} />
                <span className="flex-1 text-xs text-ctp-text truncate">{f.path}</span>
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
            <div className="px-3 py-1.5 text-xs font-semibold text-yellow-300 uppercase tracking-wider">
              Changes ({unstaged.length})
            </div>
            {unstaged.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-2 px-3 py-1 hover:bg-surface-0 cursor-pointer group"
                onClick={() => setSelectedGitFile({ path: f.path, staged: f.staged })}
              >
                <StatusIcon status={f.status} />
                <span className="flex-1 text-xs text-ctp-text truncate">{f.path}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleStage(f); }}
                  className="text-xs text-ctp-subtext0 hover:text-green-300 opacity-0 group-hover:opacity-100 cursor-pointer"
                  title="Stage"
                >
                  +
                </button>
              </div>
            ))}
          </div>
        )}

        {staged.length === 0 && unstaged.length === 0 && (
          <div className="px-3 py-3 text-xs text-ctp-subtext0">
            Working tree clean
          </div>
        )}

        {/* Branches */}
        <div className="border-t border-surface-0 mt-2">
          <div className="px-3 py-1.5 text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
            Branches ({gitInfo.branches.length})
          </div>
          {gitInfo.branches.map((b) => (
            <div
              key={b}
              className={`px-3 py-1 text-xs cursor-pointer hover:bg-surface-0 flex items-center gap-2 ${
                b === gitInfo.branch ? 'text-ctp-text font-medium' : 'text-ctp-subtext0'
              }`}
              onClick={async () => {
                if (b !== gitInfo.branch) {
                  await window.clubhouse.git.checkout(activeProject.path, b);
                  refresh();
                }
              }}
            >
              {b === gitInfo.branch && (
                <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
              )}
              <span className="truncate">{b}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
