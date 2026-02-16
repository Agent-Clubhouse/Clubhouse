import { useState, useEffect, useCallback } from 'react';
import { useAgentStore, DeleteMode } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { WorktreeStatus } from '../../../shared/types';

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  M: { label: 'M', cls: 'bg-yellow-500/20 text-yellow-300' },
  A: { label: 'A', cls: 'bg-green-500/20 text-green-300' },
  D: { label: 'D', cls: 'bg-red-500/20 text-red-300' },
  '??': { label: '??', cls: 'bg-blue-500/20 text-blue-300' },
  R: { label: 'R', cls: 'bg-purple-500/20 text-purple-300' },
};

interface OptionCard {
  mode: DeleteMode;
  label: string;
  description: string;
  icon: string;
  destructive?: boolean;
}

const DIRTY_OPTIONS: OptionCard[] = [
  {
    mode: 'commit-push',
    label: 'Commit & push',
    description: 'Commit all changes to the current branch and push, then delete.',
    icon: '\u2191',
  },
  {
    mode: 'cleanup-branch',
    label: 'Cleanup branch',
    description: 'Save to a <name>/cleanup branch, push, then delete.',
    icon: '\u2442',
  },
  {
    mode: 'save-patch',
    label: 'Save as patch',
    description: 'Export all changes to a .patch file, then delete.',
    icon: '\u2913',
  },
  {
    mode: 'force',
    label: 'Force delete',
    description: 'Delete everything immediately. Uncommitted work will be lost.',
    icon: '\u2717',
    destructive: true,
  },
  {
    mode: 'unregister',
    label: 'Leave files',
    description: 'Remove from sidebar only. Worktree and files stay on disk.',
    icon: '\u21A9',
  },
];

export function DeleteAgentDialog() {
  const { deleteDialogAgent, closeDeleteDialog, executeDelete, agents } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agent = deleteDialogAgent ? agents[deleteDialogAgent] : null;

  const fetchStatus = useCallback(async () => {
    if (!deleteDialogAgent || !activeProject) return;
    setLoading(true);
    try {
      const s = await window.clubhouse.agent.getWorktreeStatus(activeProject.path, deleteDialogAgent);
      setStatus(s);
    } catch {
      setStatus(null);
    }
    setLoading(false);
  }, [deleteDialogAgent, activeProject]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDeleteDialog();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [closeDeleteDialog]);

  if (!agent || !activeProject) return null;

  const handleExecute = async (mode: DeleteMode) => {
    setExecuting(true);
    setError(null);
    try {
      const result = await executeDelete(mode, activeProject.path);
      if (!result.ok && result.message !== 'cancelled') {
        setError(result.message);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred');
    }
    setExecuting(false);
  };

  // Non-worktree agents get a simple unregister dialog
  if (!agent.worktreePath) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeDeleteDialog}>
        <div
          className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[400px] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 className="text-base font-semibold text-ctp-text mb-2">
            Remove {agent.name}?
          </h2>
          <p className="text-sm text-ctp-subtext0 mb-4">
            This agent has no worktree. It will be removed from the sidebar.
          </p>
          {error && (
            <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={closeDeleteDialog}
              disabled={executing}
              className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                hover:bg-surface-2 cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => handleExecute('unregister')}
              disabled={executing}
              className="px-4 py-1.5 text-xs rounded bg-red-500/80 text-white
                hover:bg-red-500 cursor-pointer font-medium disabled:opacity-50 flex items-center gap-1.5"
            >
              {executing && <span className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin" />}
              Remove
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isDirty = status?.isValid &&
    (status.uncommittedFiles.length > 0 || status.unpushedCommits.length > 0);

  const handleSimpleDelete = () => handleExecute('force');
  const handleLeaveFiles = () => handleExecute('unregister');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={closeDeleteDialog}>
      <div
        className="bg-ctp-mantle border border-surface-0 rounded-xl p-5 w-[480px] shadow-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-ctp-subtext0 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !isDirty ? (
          /* Clean state — simple confirmation */
          <>
            <h2 className="text-base font-semibold text-ctp-text mb-2">
              Delete {agent.name}?
            </h2>
            <p className="text-sm text-ctp-subtext0 mb-4">
              {status?.isValid
                ? 'This will remove the worktree and branch. No uncommitted changes detected.'
                : 'This agent\'s worktree could not be inspected. It may have already been removed.'}
            </p>

            {error && (
              <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={closeDeleteDialog}
                disabled={executing}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleLeaveFiles}
                disabled={executing}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 cursor-pointer disabled:opacity-50"
              >
                Leave files
              </button>
              <button
                onClick={handleSimpleDelete}
                disabled={executing}
                className="px-4 py-1.5 text-xs rounded bg-red-500/80 text-white
                  hover:bg-red-500 cursor-pointer font-medium disabled:opacity-50 flex items-center gap-1.5"
              >
                {executing && <span className="w-3 h-3 border-2 border-white/50 border-t-white rounded-full animate-spin" />}
                Delete
              </button>
            </div>
          </>
        ) : (
          /* Dirty state — show changes and options */
          <>
            <h2 className="text-base font-semibold text-ctp-text mb-1">
              Delete {agent.name}?
            </h2>
            <p className="text-xs text-ctp-subtext0 mb-3">
              This agent has unsaved work. Choose how to handle it{!status.hasRemote ? ' (local only — no remote)' : ''}.
            </p>

            {error && (
              <div className="mb-3 px-3 py-2 rounded bg-red-500/10 border border-red-500/30 text-red-300 text-xs">
                {error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto min-h-0 mb-3 space-y-3">
              {/* Uncommitted files */}
              {status.uncommittedFiles.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                    Uncommitted changes ({status.uncommittedFiles.length})
                  </div>
                  <div className="max-h-[120px] overflow-y-auto bg-surface-0 rounded border border-surface-0 p-2 space-y-0.5">
                    {status.uncommittedFiles.map((f) => {
                      const badge = STATUS_BADGE[f.status] || { label: f.status, cls: 'bg-gray-500/20 text-gray-300' };
                      return (
                        <div key={f.path} className="flex items-center gap-2 text-xs">
                          <span className={`px-1 py-0.5 rounded text-[10px] font-mono font-bold ${badge.cls}`}>
                            {badge.label}
                          </span>
                          <span className="text-ctp-subtext1 truncate">{f.path}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Unpushed commits */}
              {status.unpushedCommits.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-1.5">
                    Unpushed commits ({status.unpushedCommits.length})
                  </div>
                  <div className="max-h-[120px] overflow-y-auto bg-surface-0 rounded border border-surface-0 p-2 space-y-0.5">
                    {status.unpushedCommits.map((c) => (
                      <div key={c.hash} className="flex items-center gap-2 text-xs">
                        <span className="text-ctp-peach font-mono flex-shrink-0">{c.shortHash}</span>
                        <span className="text-ctp-subtext1 truncate">{c.subject}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Option cards */}
              <div className="space-y-1.5">
                {DIRTY_OPTIONS.map((opt) => (
                  <button
                    key={opt.mode}
                    onClick={() => handleExecute(opt.mode)}
                    disabled={executing}
                    className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors cursor-pointer disabled:opacity-50 flex items-start gap-3 ${
                      opt.destructive
                        ? 'border-red-500/20 hover:border-red-500/40 hover:bg-red-500/5'
                        : 'border-surface-0 hover:border-surface-2 hover:bg-surface-0'
                    }`}
                  >
                    <span className="text-base flex-shrink-0 mt-0.5">{opt.icon}</span>
                    <div className="min-w-0">
                      <div className={`text-sm font-medium ${opt.destructive ? 'text-red-300' : 'text-ctp-text'}`}>
                        {opt.label}
                      </div>
                      <div className="text-xs text-ctp-subtext0 mt-0.5">{opt.description}</div>
                    </div>
                    {executing && (
                      <span className="w-3 h-3 border-2 border-ctp-subtext0 border-t-transparent rounded-full animate-spin flex-shrink-0 mt-1" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={closeDeleteDialog}
                disabled={executing}
                className="px-3 py-1.5 text-xs rounded bg-surface-1 text-ctp-subtext1
                  hover:bg-surface-2 cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
