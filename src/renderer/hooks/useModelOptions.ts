import { useState, useEffect } from 'react';
import { useProjectStore } from '../stores/projectStore';

const DEFAULT_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
];

/**
 * Fetches model options from the orchestrator provider for the active project.
 * Pass an orchestrator ID to get options for a specific provider (e.g. in the
 * Add Agent dialog where the user picks an orchestrator per-agent).
 * Falls back to defaults if no project is active or fetch fails.
 */
export function useModelOptions(orchestrator?: string): Array<{ id: string; label: string }> {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const projects = useProjectStore((s) => s.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);

  useEffect(() => {
    if (!activeProject?.path) {
      setOptions(DEFAULT_OPTIONS);
      return;
    }
    window.clubhouse.agent.getModelOptions(activeProject.path, orchestrator)
      .then((result: Array<{ id: string; label: string }>) => {
        if (Array.isArray(result) && result.length > 0) {
          setOptions(result);
        }
      })
      .catch(() => {
        // Keep defaults on error
      });
  }, [activeProject?.path, orchestrator]);

  return options;
}
