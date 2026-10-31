/**
 * Helpers whose orchestrator is in another project (#2514). The helper's row
 * stays in its own project; these name the project its orchestrator is in.
 */

import type { Agent, Project } from '../../../../shared/types';
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
