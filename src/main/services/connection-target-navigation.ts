import * as path from 'path';
import type { AgentNavigationTarget, GroupProjectNavigationIndex } from '../../shared/canvas-index-types';
import type { NavigableCanvasTargetKind } from '../../shared/canvas-persistence';
import { isDisposedAgent } from '../../shared/agent-helpers';
import { peekProjectsChecked } from './project-store';
import { peekDurableConfigsChecked } from './agent-config';
import { agentRegistry } from './agent-registry';
import { groupProjectRegistry } from './group-project-registry';
import { getTargetCanvasIndex, readCanvasForNavigation } from './canvas-store-reader';

/** Resolve the real ID across all registered projects, without loading/migrating agent configs. */
export async function resolveAgentNavigationTarget(agentId: string): Promise<AgentNavigationTarget> {
  const registered = await peekProjectsChecked({ strict: true });
  if (!registered.readable) return { error: 'Registered projects could not be read. Repair the project list and retry Open.' };
  const inventories = await Promise.all(registered.projects.map(async (project) => ({
    project, ...await peekDurableConfigsChecked(project.path, { strict: true }),
  })));
  if (inventories.some((entry) => !entry.readable)) {
    return { error: 'Some project agents could not be read. Repair the affected project and retry Open; no target was guessed.' };
  }
  const live = agentRegistry.get(agentId);
  const matches = inventories.flatMap(({ project, agents }) => {
    const config = agents.find((agent) => agent.id === agentId);
    if (config && isDisposedAgent(config)) return [];
    if (config || (live && path.resolve(live.projectPath) === path.resolve(project.path))) return [{ project, ...(config && { config }) }];
    return [];
  });
  if (matches.length !== 1) {
    return { error: matches.length > 1
      ? 'This agent ID exists in more than one project. Repair the duplicate IDs and retry Open.'
      : 'This agent is unavailable in registered projects. Restore or re-register its original project, then retry Open.' };
  }
  return matches[0];
}

export async function resolveTargetCanvasIndex(kind: NavigableCanvasTargetKind, targetId: string): Promise<GroupProjectNavigationIndex> {
  const index = await getTargetCanvasIndex(kind, targetId);
  const groupProjects = await groupProjectRegistry.peek();
  if (kind === 'group-project' && !groupProjects.some((project) => project.id === targetId)) {
    return { stores: [], error: 'This group project no longer exists. Restore the original group project, then retry Open.' };
  }
  return { ...index, groupProjects };
}

export async function readTargetCanvasForNavigation(kind: NavigableCanvasTargetKind, targetId: string, projectId?: string) {
  const snapshot = await readCanvasForNavigation(projectId);
  const groupProjects = await groupProjectRegistry.peek();
  if (kind === 'group-project' && !groupProjects.some((project) => project.id === targetId)) {
    throw new Error('This group project was deleted before the Canvas opened. Retry Open to refresh the target.');
  }
  return { ...snapshot, groupProjects };
}
