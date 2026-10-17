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
 * Resets to a minimal placeholder immediately on orchestrator change so stale
 * options from the previous provider are never shown.
 */
export function useModelOptions(orchestrator?: string, projectPath?: string): ModelOptionsResult {
  const [options, setOptions] = useState(LOADING_OPTIONS);
  const [loading, setLoading] = useState(true);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const path = projectPath ?? projects.find((p) => p.id === activeProjectId)?.path;

  useEffect(() => {
    // Immediately clear stale options from previous provider
    setOptions(LOADING_OPTIONS);
    setLoading(true);

    if (!path) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    window.clubhouse.agent.getModelOptions(path, orchestrator)
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
  }, [path, orchestrator]);

  return { options, loading };
}
