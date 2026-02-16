import { useState, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';

const LOADING_OPTIONS = [{ id: 'default', label: 'Default' }];

interface ModelOptionsResult {
  options: Array<{ id: string; label: string }>;
  loading: boolean;
}

/**
 * Fetches model options from the orchestrator provider for the active project.
 * Resets to a minimal placeholder immediately on orchestrator change so stale
 * options from the previous provider are never shown.
 */
export function useModelOptions(orchestrator?: string): ModelOptionsResult {
  const [options, setOptions] = useState(LOADING_OPTIONS);
  const [loading, setLoading] = useState(true);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    // Immediately clear stale options from previous provider
    setOptions(LOADING_OPTIONS);
    setLoading(true);

    if (!activeProject?.path) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    window.clubhouse.agent.getModelOptions(activeProject.path, orchestrator)
      .then((result) => {
        if (!cancelled && Array.isArray(result) && result.length > 0) {
          setOptions(result);
        }
      })
      .catch(() => {
        // Keep loading placeholder on error
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeProject?.path, orchestrator]);

  return { options, loading };
}
