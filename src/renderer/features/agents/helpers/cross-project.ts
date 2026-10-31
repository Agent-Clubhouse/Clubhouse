/**
 * Helpers whose orchestrator is in another project (#2514). The helper's row
 * stays in its own project; these name the project its orchestrator is in.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Agent, HelperInProject, Project } from '../../../../shared/types';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { findProjectByPath } from '../../../utils/project-path';

/** A project's name as the sidebar shows it, or the folder name for one that isn't open. */
export function projectLabel(project: Pick<Project, 'name' | 'displayName'> | undefined, projectPath: string): string {
  if (project) return project.displayName || project.name;
  return projectPath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || projectPath;
}

/** "Helper of Ada in Annex", or "Helper of an agent in Annex" when the orchestrator isn't loaded. */
export function otherProjectParentText(parentName: string | undefined, projectName: string): string {
  return `Helper of ${parentName ?? 'an agent'} in ${projectName}`;
}

/** The name of the project an agent's orchestrator is in, when that is another project. */
export function useParentProjectName(agent: Pick<Agent, 'parentProjectPath' | 'parentProjectId'>): string | undefined {
  return useProjectStore((s) => {
    if (!agent.parentProjectPath) return undefined;
    const project = (agent.parentProjectId ? s.projects.find((p) => p.id === agent.parentProjectId) : undefined)
      ?? findProjectByPath(s.projects, agent.parentProjectPath);
    return projectLabel(project, agent.parentProjectPath);
  });
}

/** The sidebar's line for a helper whose orchestrator is in another project, or undefined. */
export function useOtherProjectParentText(agent: Pick<Agent, 'parentAgentId' | 'parentProjectPath' | 'parentProjectId'>): string | undefined {
  const projectName = useParentProjectName(agent);
  const parentName = useAgentStore((s) => (agent.parentAgentId ? s.agents[agent.parentAgentId]?.name : undefined));
  return agent.parentAgentId && projectName ? otherProjectParentText(parentName, projectName) : undefined;
}

/**
 * An orchestrator's direct helpers in every project, disposed ones included,
 * each with its own project. Re-read when any project's agent configs change
 * (a helper can be in any of them), when a helper on the rail starts, wakes,
 * sleeps or goes, and on `reload`.
 */
export function useHelpersEverywhere(projectPath: string | undefined, agentId: string): {
  helpers: HelperInProject[] | null;
  reload: () => void;
} {
  // A string, so the hook re-reads only when one of its helpers changes.
  const railKey = useAgentStore((s) => Object.values(s.agents)
    .filter((a) => a.kind === 'durable' && a.parentAgentId === agentId)
    .map((a) => `${a.id}:${a.projectId}:${a.status}:${a.creationFailed ? 'f' : ''}`)
    .join(','));
  const [helpers, setHelpers] = useState<HelperInProject[] | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!projectPath) return;
    return window.clubhouse.agent.onConfigsChanged?.(() => setNonce((n) => n + 1));
  }, [projectPath]);
  useEffect(() => {
    if (!projectPath) { setHelpers(null); return; }
    let alive = true;
    Promise.resolve().then(() => window.clubhouse.agent.listHelpers(projectPath, agentId, false, true)).then(
      (list) => { if (alive) setHelpers(Array.isArray(list) ? list : []); },
      // telemetry-exempt: the card says there are no helpers rather than break details.
      () => { if (alive) setHelpers([]); },
    );
    return () => { alive = false; };
  }, [projectPath, agentId, railKey, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { helpers, reload };
}
