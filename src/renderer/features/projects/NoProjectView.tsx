import { useEffect } from 'react';
import { useProjectStore } from '../../stores/projectStore';
import { useChromeStore } from '../../chrome/chromeStore';

/**
 * The classic layout's pane when no project is open and no satellite is
 * selected. Home was removed for v1: with projects, this reopens the most
 * recently active one (falling back to the first), as the new shell does, so
 * it only shows Add Project on first run.
 */
export function NoProjectView() {
  const projectsLoaded = useProjectStore((s) => s.projectsLoaded);
  const projects = useProjectStore((s) => s.projects);
  const pickAndAddProject = useProjectStore((s) => s.pickAndAddProject);
  const lastProjectId = useChromeStore((s) => s.lastProjectId);

  const fallbackProjectId = (lastProjectId && projects.some((p) => p.id === lastProjectId) ? lastProjectId : projects[0]?.id) ?? null;
  useEffect(() => {
    if (fallbackProjectId) useProjectStore.getState().setActiveProject(fallbackProjectId);
  }, [fallbackProjectId]);

  if (!projectsLoaded || projects.length > 0) return <div className="h-full" data-testid="no-project-view" />;

  return (
    <div className="h-full flex flex-col items-center justify-center p-8 text-center" data-testid="no-project-view">
      <div className="w-16 h-16 rounded-2xl bg-surface-0 flex items-center justify-center mb-4">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ctp-subtext0" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      </div>
      <h1 className="text-base font-semibold text-ctp-text mb-1">No projects yet</h1>
      <p className="text-sm text-ctp-subtext0 mb-5 max-w-xs">
        Add a project folder to get started with managing agents.
      </p>
      <button
        onClick={() => pickAndAddProject()}
        className="px-4 py-2 rounded-lg bg-ctp-accent text-ctp-on-accent text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
      >
        Add Project
      </button>
    </div>
  );
}
