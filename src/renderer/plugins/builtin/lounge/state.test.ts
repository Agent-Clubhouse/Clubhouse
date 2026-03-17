import { describe, it, expect } from 'vitest';
import { createLoungeStore, groupAgentsByCategory, disambiguateAgentName } from './state';
import type { LoungeCategory } from './state';
import type { AgentInfo, ProjectInfo } from '../../../../shared/plugin-types';

function makeAgent(overrides: Partial<AgentInfo> & { id: string; projectId: string }): AgentInfo {
  return {
    name: 'agent-1',
    kind: 'durable',
    status: 'running',
    color: 'blue',
    ...overrides,
  };
}

function makeProject(overrides: Partial<ProjectInfo> & { id: string }): ProjectInfo {
  return {
    name: overrides.id,
    path: `/projects/${overrides.id}`,
    ...overrides,
  };
}

describe('createLoungeStore', () => {
  it('initializes with empty state', () => {
    const store = createLoungeStore();
    const state = store.getState();
    expect(state.categories).toEqual([]);
    expect(state.collapsed.size).toBe(0);
    expect(state.selectedAgentId).toBeNull();
    expect(state.selectedProjectId).toBeNull();
  });

  describe('deriveCategories', () => {
    it('creates one category per project', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([
        makeProject({ id: 'proj-1', name: 'Project One' }),
        makeProject({ id: 'proj-2', name: 'Project Two' }),
      ]);
      const { categories } = store.getState();
      expect(categories).toHaveLength(2);
      expect(categories[0]).toEqual({ id: 'project:proj-1', label: 'Project One', projectId: 'proj-1' });
      expect(categories[1]).toEqual({ id: 'project:proj-2', label: 'Project Two', projectId: 'proj-2' });
    });

    it('preserves collapsed state for surviving categories', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([
        makeProject({ id: 'proj-1' }),
        makeProject({ id: 'proj-2' }),
      ]);
      store.getState().toggleCollapsed('project:proj-1');
      expect(store.getState().collapsed.has('project:proj-1')).toBe(true);

      // Re-derive with proj-1 still present
      store.getState().deriveCategories([
        makeProject({ id: 'proj-1' }),
        makeProject({ id: 'proj-3' }),
      ]);
      expect(store.getState().collapsed.has('project:proj-1')).toBe(true);
      expect(store.getState().collapsed.has('project:proj-2')).toBe(false);
    });

    it('removes collapsed state for removed categories', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([makeProject({ id: 'proj-1' })]);
      store.getState().toggleCollapsed('project:proj-1');

      store.getState().deriveCategories([makeProject({ id: 'proj-2' })]);
      expect(store.getState().collapsed.has('project:proj-1')).toBe(false);
    });
  });

  describe('toggleCollapsed', () => {
    it('toggles a category collapsed state', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([makeProject({ id: 'proj-1' })]);

      store.getState().toggleCollapsed('project:proj-1');
      expect(store.getState().collapsed.has('project:proj-1')).toBe(true);

      store.getState().toggleCollapsed('project:proj-1');
      expect(store.getState().collapsed.has('project:proj-1')).toBe(false);
    });
  });

  describe('selectAgent', () => {
    it('sets selectedAgentId and selectedProjectId', () => {
      const store = createLoungeStore();
      store.getState().selectAgent('agent-1', 'proj-1');
      expect(store.getState().selectedAgentId).toBe('agent-1');
      expect(store.getState().selectedProjectId).toBe('proj-1');
    });

    it('clears selection when null', () => {
      const store = createLoungeStore();
      store.getState().selectAgent('agent-1', 'proj-1');
      store.getState().selectAgent(null);
      expect(store.getState().selectedAgentId).toBeNull();
      expect(store.getState().selectedProjectId).toBeNull();
    });
  });

  describe('renameCategory', () => {
    it('updates the category label', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([makeProject({ id: 'proj-1', name: 'Original' })]);
      store.getState().renameCategory('project:proj-1', 'Custom Name');
      expect(store.getState().categories[0].label).toBe('Custom Name');
    });

    it('persists renamed label across deriveCategories calls', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([makeProject({ id: 'proj-1', name: 'Original' })]);
      store.getState().renameCategory('project:proj-1', 'My Label');

      // Re-derive — renamed label should persist
      store.getState().deriveCategories([makeProject({ id: 'proj-1', name: 'Original' })]);
      expect(store.getState().categories[0].label).toBe('My Label');
    });

    it('stores the renamed label in renamedLabels', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([makeProject({ id: 'proj-1' })]);
      store.getState().renameCategory('project:proj-1', 'Renamed');
      expect(store.getState().renamedLabels['project:proj-1']).toBe('Renamed');
    });

    it('does not affect other categories', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([
        makeProject({ id: 'proj-1', name: 'One' }),
        makeProject({ id: 'proj-2', name: 'Two' }),
      ]);
      store.getState().renameCategory('project:proj-1', 'Renamed One');
      expect(store.getState().categories[0].label).toBe('Renamed One');
      expect(store.getState().categories[1].label).toBe('Two');
    });
  });
});

describe('groupAgentsByCategory', () => {
  it('groups agents into their project categories', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
      { id: 'project:p2', label: 'P2', projectId: 'p2' },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
      makeAgent({ id: 'a2', projectId: 'p2' }),
      makeAgent({ id: 'a3', projectId: 'p1' }),
    ];

    const grouped = groupAgentsByCategory(agents, categories);
    expect(grouped.get('project:p1')).toHaveLength(2);
    expect(grouped.get('project:p2')).toHaveLength(1);
  });

  it('returns empty arrays for categories with no agents', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
    ];
    const grouped = groupAgentsByCategory([], categories);
    expect(grouped.get('project:p1')).toEqual([]);
  });

  it('ignores agents with no matching category', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
      makeAgent({ id: 'a2', projectId: 'unknown' }),
    ];

    const grouped = groupAgentsByCategory(agents, categories);
    expect(grouped.get('project:p1')).toHaveLength(1);
  });
});

describe('disambiguateAgentName', () => {
  it('returns plain name when unique', () => {
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1', name: 'alpha' }),
      makeAgent({ id: 'a2', projectId: 'p1', name: 'beta' }),
    ];
    const projects = [makeProject({ id: 'p1', name: 'MyProject' })];
    expect(disambiguateAgentName(agents[0], agents, projects)).toBe('alpha');
  });

  it('prepends project name when name is duplicated', () => {
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1', name: 'agent' }),
      makeAgent({ id: 'a2', projectId: 'p2', name: 'agent' }),
    ];
    const projects = [
      makeProject({ id: 'p1', name: 'Frontend' }),
      makeProject({ id: 'p2', name: 'Backend' }),
    ];

    expect(disambiguateAgentName(agents[0], agents, projects)).toBe('Frontend/agent');
    expect(disambiguateAgentName(agents[1], agents, projects)).toBe('Backend/agent');
  });

  it('falls back to projectId when project not found', () => {
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1', name: 'agent' }),
      makeAgent({ id: 'a2', projectId: 'p2', name: 'agent' }),
    ];
    expect(disambiguateAgentName(agents[0], agents, [])).toBe('p1/agent');
  });
});
