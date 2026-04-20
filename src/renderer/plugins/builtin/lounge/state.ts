import { create } from 'zustand';
import type { AgentInfo, ProjectInfo } from '../../../../shared/plugin-types';

// ── Constants ────────────────────────────────────────────────────────────

/** The permanent catch-all circle ID. Cannot be renamed or deleted. */
export const DEFAULT_CIRCLE_ID = 'circle:general';
export const DEFAULT_CIRCLE_LABEL = 'General';
export const DEFAULT_CIRCLE_EMOJI = '💬';
export const DEFAULT_PROJECT_EMOJI = '📁';
export const DEFAULT_CUSTOM_EMOJI = '⭐';

/** Reserved circle names (case-insensitive). */
const RESERVED_NAMES = new Set(['general']);

/** Check whether a label collides with a reserved name. */
export function isReservedCircleName(label: string): boolean {
  return RESERVED_NAMES.has(label.toLowerCase().trim());
}

/** Returns true if the category is the permanent default circle. */
export function isDefaultCircle(categoryId: string): boolean {
  return categoryId === DEFAULT_CIRCLE_ID;
}

// ── Types ────────────────────────────────────────────────────────────────

export interface LoungeCategory {
  id: string;
  label: string;
  /** Emoji icon displayed before the label. */
  emoji?: string;
  /** When derived from a project, holds the project ID. Absent for custom circles. */
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
  /** User-defined label overrides keyed by category ID. */
  renamedLabels: Record<string, string>;
  /** Agent-to-category overrides: agentId → categoryId. */
  agentCategoryOverrides: Record<string, string>;
  /** Custom user-created circles (persisted independently of projects). */
  customCircles: LoungeCategory[];
  /** Counter for generating unique custom circle IDs. */
  nextCircleId: number;
  /** User-defined category ordering (persisted across derive calls). */
  categoryOrder: string[];
  /** User-defined emoji overrides keyed by category ID. */
  categoryEmojis: Record<string, string>;
  /** Whether persisted state has been loaded (blocks mutations until true). */
  hydrated: boolean;

  // Actions
  deriveCategories(projects: ProjectInfo[]): void;
  toggleCollapsed(categoryId: string): void;
  selectAgent(agentId: string | null, projectId?: string | null): void;
  renameCategory(categoryId: string, label: string): void;
  moveAgent(agentId: string, targetCategoryId: string): void;
  addCircle(label: string): string;
  reorderCategory(fromId: string, toId: string): void;
  setCategoryEmoji(categoryId: string, emoji: string): void;
  /** Hydrate store from persisted data. */
  loadPersistedState(data: LoungePersistedState): void;
}

/** Subset of LoungeState that is persisted to storage. */
export interface LoungePersistedState {
  renamedLabels: Record<string, string>;
  agentCategoryOverrides: Record<string, string>;
  customCircles: LoungeCategory[];
  nextCircleId: number;
  categoryOrder: string[];
  categoryEmojis: Record<string, string>;
  collapsed: string[];
}

/** Extract the persistable subset from the store. */
export function getPersistedState(state: LoungeState): LoungePersistedState {
  return {
    renamedLabels: state.renamedLabels,
    agentCategoryOverrides: state.agentCategoryOverrides,
    customCircles: state.customCircles,
    nextCircleId: state.nextCircleId,
    categoryOrder: state.categoryOrder,
    categoryEmojis: state.categoryEmojis,
    collapsed: Array.from(state.collapsed),
  };
}

/**
 * Group agents by their categories. Returns a map of categoryId → agents.
 * Agents belong to the category matching their projectId, unless overridden.
 * Agents with no matching category fall into the default "General" circle.
 */
export function groupAgentsByCategory(
  agents: AgentInfo[],
  categories: LoungeCategory[],
  overrides: Record<string, string> = {},
): Map<string, AgentInfo[]> {
  const projectToCategory = new Map<string, string>();
  for (const cat of categories) {
    if (cat.projectId) {
      projectToCategory.set(cat.projectId, cat.id);
    }
  }

  const validCategoryIds = new Set(categories.map((c) => c.id));

  const groups = new Map<string, AgentInfo[]>();
  for (const cat of categories) {
    groups.set(cat.id, []);
  }

  for (const agent of agents) {
    const overrideCatId = overrides[agent.id];
    // Use override if it points to a valid category, otherwise fall back to project
    const catId = (overrideCatId && validCategoryIds.has(overrideCatId))
      ? overrideCatId
      : projectToCategory.get(agent.projectId);
    if (catId && groups.has(catId)) {
      groups.get(catId)!.push(agent);
    } else if (groups.has(DEFAULT_CIRCLE_ID)) {
      // Catch-all: agents with no matching category go to General
      groups.get(DEFAULT_CIRCLE_ID)!.push(agent);
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

// ── Default circle (always present) ──────────────────────────────────────

const GENERAL_CIRCLE: LoungeCategory = { id: DEFAULT_CIRCLE_ID, label: DEFAULT_CIRCLE_LABEL, emoji: DEFAULT_CIRCLE_EMOJI };

/**
 * Apply user-defined order to categories. Categories not in the order list
 * are appended in their natural position. General is always forced to the end.
 */
function applyCategoryOrder(categories: LoungeCategory[], order: string[]): LoungeCategory[] {
  if (order.length === 0) return categories;

  const byId = new Map(categories.map((c) => [c.id, c]));
  const result: LoungeCategory[] = [];
  const placed = new Set<string>();

  // Place categories that appear in the order list
  for (const id of order) {
    if (id === DEFAULT_CIRCLE_ID) continue; // General always last
    const cat = byId.get(id);
    if (cat) {
      result.push(cat);
      placed.add(id);
    }
  }

  // Append any remaining categories not in the order (except General)
  for (const cat of categories) {
    if (!placed.has(cat.id) && cat.id !== DEFAULT_CIRCLE_ID) {
      result.push(cat);
    }
  }

  // General always last
  const general = byId.get(DEFAULT_CIRCLE_ID);
  if (general) result.push(general);

  return result;
}

// ── Store ────────────────────────────────────────────────────────────────

export const createLoungeStore = () =>
  create<LoungeState>((set, get) => ({
    categories: [GENERAL_CIRCLE],
    collapsed: new Set<string>(),
    selectedAgentId: null,
    selectedProjectId: null,
    renamedLabels: {},
    agentCategoryOverrides: {},
    customCircles: [],
    nextCircleId: 1,
    categoryOrder: [],
    categoryEmojis: {},
    hydrated: false,

    deriveCategories(projects: ProjectInfo[]) {
      set((state) => {
        const projectCategories: LoungeCategory[] = projects.map((p) => {
          const catId = `project:${p.id}`;
          // Disambiguate project labels that collide with reserved names
          const rawLabel = state.renamedLabels[catId] ?? p.name;
          const label = isReservedCircleName(rawLabel) ? `${rawLabel} (project)` : rawLabel;
          return {
            id: catId,
            label,
            emoji: state.categoryEmojis[catId] ?? DEFAULT_PROJECT_EMOJI,
            projectId: p.id,
          };
        });

        // Apply emoji overrides to custom circles
        const customWithEmojis = state.customCircles.map((c) => ({
          ...c,
          emoji: state.categoryEmojis[c.id] ?? c.emoji,
        }));

        // Apply emoji override to General
        const general: LoungeCategory = {
          ...GENERAL_CIRCLE,
          emoji: state.categoryEmojis[DEFAULT_CIRCLE_ID] ?? GENERAL_CIRCLE.emoji,
        };

        // Merge all categories, then apply saved order
        const unordered = [...projectCategories, ...customWithEmojis, general];
        const newCategories = applyCategoryOrder(unordered, state.categoryOrder);

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

    renameCategory(categoryId: string, label: string) {
      // Cannot rename the default circle
      if (isDefaultCircle(categoryId)) return;
      // Cannot use a reserved name
      if (isReservedCircleName(label)) return;
      // Block until hydrated to avoid overwriting persisted state
      if (!get().hydrated) return;

      set((state) => {
        const newLabels = { ...state.renamedLabels, [categoryId]: label };
        const newCategories = state.categories.map((c) =>
          c.id === categoryId ? { ...c, label } : c,
        );
        // Also update the custom circle source-of-truth if it's a custom one
        const newCustomCircles = state.customCircles.map((c) =>
          c.id === categoryId ? { ...c, label } : c,
        );
        return { renamedLabels: newLabels, categories: newCategories, customCircles: newCustomCircles };
      });
    },

    moveAgent(agentId: string, targetCategoryId: string) {
      if (!get().hydrated) return;
      set((state) => ({
        agentCategoryOverrides: { ...state.agentCategoryOverrides, [agentId]: targetCategoryId },
      }));
    },

    addCircle(label: string): string {
      // Reject reserved names
      if (isReservedCircleName(label)) return '';
      if (!get().hydrated) return '';

      let newId = '';
      set((state) => {
        const id = `circle:${state.nextCircleId}`;
        newId = id;
        const circle: LoungeCategory = { id, label, emoji: DEFAULT_CUSTOM_EMOJI };
        const newCustomCircles = [...state.customCircles, circle];
        // Insert before General (General is always last)
        const cats = state.categories.filter((c) => c.id !== DEFAULT_CIRCLE_ID);
        return {
          customCircles: newCustomCircles,
          categories: [...cats, circle, GENERAL_CIRCLE],
          nextCircleId: state.nextCircleId + 1,
        };
      });
      return newId;
    },

    reorderCategory(fromId: string, toId: string) {
      // Cannot move General
      if (isDefaultCircle(fromId) || isDefaultCircle(toId)) return;
      if (fromId === toId) return;
      if (!get().hydrated) return;

      set((state) => {
        const cats = state.categories.filter((c) => c.id !== DEFAULT_CIRCLE_ID);
        const fromIdx = cats.findIndex((c) => c.id === fromId);
        const toIdx = cats.findIndex((c) => c.id === toId);
        if (fromIdx === -1 || toIdx === -1) return state;

        const reordered = [...cats];
        const [moved] = reordered.splice(fromIdx, 1);
        reordered.splice(toIdx, 0, moved);
        reordered.push(GENERAL_CIRCLE);

        return {
          categories: reordered,
          categoryOrder: reordered.map((c) => c.id),
        };
      });
    },

    setCategoryEmoji(categoryId: string, emoji: string) {
      if (!get().hydrated) return;
      set((state) => {
        const newEmojis = { ...state.categoryEmojis, [categoryId]: emoji };
        const newCategories = state.categories.map((c) =>
          c.id === categoryId ? { ...c, emoji } : c,
        );
        const newCustomCircles = state.customCircles.map((c) =>
          c.id === categoryId ? { ...c, emoji } : c,
        );
        return { categoryEmojis: newEmojis, categories: newCategories, customCircles: newCustomCircles };
      });
    },

    loadPersistedState(data: LoungePersistedState) {
      set({
        renamedLabels: data.renamedLabels ?? {},
        agentCategoryOverrides: data.agentCategoryOverrides ?? {},
        customCircles: data.customCircles ?? [],
        nextCircleId: data.nextCircleId ?? 1,
        categoryOrder: data.categoryOrder ?? [],
        categoryEmojis: data.categoryEmojis ?? {},
        collapsed: new Set(data.collapsed ?? []),
        hydrated: true,
      });
    },
  }));
