import { useEffect, useState, useCallback } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { GitLogEntry } from '../../../shared/types';

export function GitLog() {
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const [log, setLog] = useState<GitLogEntry[]>([]);

  const refresh = useCallback(async () => {
    if (!activeProject) return;
    const info = await window.clubhouse.git.info(activeProject.path);
    if (info.hasGit) {
      setLog(info.log);
    }
  }, [activeProject]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (log.length === 0) {
    return (
      <div className="flex items-center justify-center h-full bg-ctp-base">
        <p className="text-ctp-subtext0 text-sm">No commits yet</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-ctp-subtext0 uppercase tracking-wider">
            Commit History
          </h2>
          <button
            onClick={refresh}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text cursor-pointer"
          >
            Refresh
          </button>
        </div>
        <div className="space-y-1">
          {log.map((entry) => (
            <div
              key={entry.hash}
              className="flex items-start gap-3 px-3 py-2 rounded-lg hover:bg-surface-0/50 transition-colors"
            >
              <span className="text-xs font-mono text-indigo-300 mt-0.5 flex-shrink-0">
                {entry.shortHash}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ctp-text truncate">{entry.subject}</p>
                <p className="text-xs text-ctp-subtext0 mt-0.5">
                  {entry.author} · {entry.date}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
