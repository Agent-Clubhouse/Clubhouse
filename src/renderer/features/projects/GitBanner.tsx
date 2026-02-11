import { useState } from 'react';
import { useProjectStore } from '../../stores/projectStore';

export function GitBanner() {
  const { activeProjectId, projects, gitStatus, gitInit } = useProjectStore();
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  const [initing, setIniting] = useState(false);

  if (!activeProjectId) return null;
  const project = projects.find((p) => p.id === activeProjectId);
  if (!project) return null;

  const hasGit = gitStatus[activeProjectId];
  if (hasGit !== false || dismissed[activeProjectId]) return null;

  const handleGitInit = async () => {
    setIniting(true);
    await gitInit(activeProjectId, project.path);
    setIniting(false);
  };

  return (
    <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-200 text-sm">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span className="flex-1">
        No git repository detected. Some features may not be available.
      </span>
      <button
        onClick={handleGitInit}
        disabled={initing}
        className="px-3 py-1 text-xs rounded bg-yellow-500/20 hover:bg-yellow-500/30
          transition-colors cursor-pointer disabled:opacity-50"
      >
        {initing ? 'Initializing...' : 'git init'}
      </button>
      <button
        onClick={() => setDismissed((d) => ({ ...d, [activeProjectId]: true }))}
        className="text-yellow-200/50 hover:text-yellow-200 transition-colors cursor-pointer px-1"
      >
        x
      </button>
    </div>
  );
}
