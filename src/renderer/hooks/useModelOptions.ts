import { useState, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';

const LOADING_OPTIONS = [{ id: 'default', label: 'Default' }];

interface ModelOptionsResult {
  options: Array<{ id: string; label: string }>;
  loading: boolean;
}

/**
 * Fetches model options from the orchestrator provider for `projectPath`, or the
 * active project when none is given.
 * Options belong to the path and orchestrator they were read for, so a change
 * shows the placeholder and `loading` in the same render: there is no render
 * where stale or placeholder options look loaded (#2375).
 */
export function useModelOptions(orchestrator?: string, projectPath?: string): ModelOptionsResult {
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const path = projectPath ?? projects.find((p) => p.id === activeProjectId)?.path;
  const key = path ? `${orchestrator ?? ''}\n${path}` : null;
  const [loaded, setLoaded] = useState<{ key: string; options: Array<{ id: string; label: string }> } | null>(null);

  useEffect(() => {
    if (!path || !key) return;
    let cancelled = false;
    window.clubhouse.agent.getModelOptions(path, orchestrator)
      .then((result) => {
        if (!cancelled) setLoaded({ key, options: Array.isArray(result) && result.length > 0 ? result : LOADING_OPTIONS });
      })
      .catch(() => {
        // Keep loading placeholder on error
        if (!cancelled) setLoaded({ key, options: LOADING_OPTIONS });
      });

    return () => { cancelled = true; };
  }, [path, orchestrator, key]);

  const current = key !== null && loaded?.key === key ? loaded : null;
  return { options: current?.options ?? LOADING_OPTIONS, loading: key !== null && !current };
}
