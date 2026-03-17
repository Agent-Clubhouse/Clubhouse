import { create } from 'zustand';
import type { AgentInfo, ProjectInfo } from '../../../../shared/plugin-types';

// ── Types ────────────────────────────────────────────────────────────────

export interface LoungeCategory {
  id: string;
  label: string;
  /** When derived from a project, holds the project ID. */
  projectId?: string;
}

export interface LoungeState {
  categories: LoungeCategory[];
  /** Set of collapsed category IDs. */
  collapsed: Set<string>;
  /** Currently selected agent ID (displayed in the content area). */
  selectedAgentId: string | null;
  /** Project ID of the selected agent (for cross-project navigation). */
  selectedProjectId: string | null;

  // Actions
  deriveCategories(projects: ProjectInfo[]): void;
  toggleCollapsed(categoryId: string): void;
  selectAgent(agentId: string | null, projectId?: string | null): void;
}

/**
 * Group agents by their categories. Returns a map of categoryId → agents.
 * Agents belong to the category matching their projectId.
 */
export function groupAgentsByCategory(
  agents: AgentInfo[],
  categories: LoungeCategory[],
): Map<string, AgentInfo[]> {
  const projectToCategory = new Map<string, string>();
  for (const cat of categories) {
    if (cat.projectId) {
      projectToCategory.set(cat.projectId, cat.id);
    }
  }

  const groups = new Map<string, AgentInfo[]>();
  for (const cat of categories) {
    groups.set(cat.id, []);
  }

  for (const agent of agents) {
    const catId = projectToCategory.get(agent.projectId);
    if (catId) {
      groups.get(catId)!.push(agent);
    }
  }

  return groups;
}

/**
 * Build a display name for an agent, prepending "project/" if the agent's
 * name is duplicated within the same category grouping.
 */
export function disambiguateAgentName(
  agent: AgentInfo,
  allAgents: AgentInfo[],
  projects: ProjectInfo[],
): string {
  const sameNameAgents = allAgents.filter((a) => a.name === agent.name);
  if (sameNameAgents.length <= 1) return agent.name;

  const project = projects.find((p) => p.id === agent.projectId);
  const projectLabel = project?.name ?? agent.projectId;
  return `${projectLabel}/${agent.name}`;
}

// ── Store ────────────────────────────────────────────────────────────────

export const createLoungeStore = () =>
  create<LoungeState>((set) => ({
    categories: [],
    collapsed: new Set<string>(),
    selectedAgentId: null,
    selectedProjectId: null,

    deriveCategories(projects: ProjectInfo[]) {
      set((state) => {
        const newCategories: LoungeCategory[] = projects.map((p) => ({
          id: `project:${p.id}`,
          label: p.name,
          projectId: p.id,
        }));

        // Preserve collapsed state for categories that still exist
        const newIds = new Set(newCategories.map((c) => c.id));
        const newCollapsed = new Set<string>();
        for (const id of state.collapsed) {
          if (newIds.has(id)) newCollapsed.add(id);
        }

        return { categories: newCategories, collapsed: newCollapsed };
      });
    },

    toggleCollapsed(categoryId: string) {
      set((state) => {
        const next = new Set(state.collapsed);
        if (next.has(categoryId)) {
          next.delete(categoryId);
        } else {
          next.add(categoryId);
        }
        return { collapsed: next };
      });
    },

    selectAgent(agentId: string | null, projectId?: string | null) {
      set({ selectedAgentId: agentId, selectedProjectId: projectId ?? null });
    },
  }));
