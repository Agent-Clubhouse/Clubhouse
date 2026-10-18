// ── What an import matches against ───────────────────────────────────
//
// The machine state every import path hands to parseAnyBlueprint: agents and
// projects to match the blueprint's refs, and the group projects that exist
// here so a group project id from another machine isn't wired to (#2071).

import { useAgentStore } from '../../stores/agentStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { useProjectStore } from '../../stores/projectStore';
import type { ParseContext } from './parse-blueprint';

/** Group project ids on this machine, or undefined when they couldn't be loaded (ids are then kept). */
async function knownGroupProjectIds(): Promise<ReadonlySet<string> | undefined> {
  if (!useGroupProjectStore.getState().loaded) await useGroupProjectStore.getState().loadProjects();
  const { projects, loadError } = useGroupProjectStore.getState();
  return loadError ? undefined : new Set(projects.map((p) => p.id));
}

export async function blueprintParseContext(activeProjectId?: string): Promise<ParseContext> {
  return {
    agents: Object.values(useAgentStore.getState().agents),
    projects: useProjectStore.getState().projects.map((p) => ({ id: p.id, name: p.name, path: p.path })),
    activeProjectId,
    groupProjectIds: await knownGroupProjectIds(),
  };
}
