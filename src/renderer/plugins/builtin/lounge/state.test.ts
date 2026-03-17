import { describe, it, expect } from 'vitest';
import { createLoungeStore, groupAgentsByCategory, disambiguateAgentName, DEFAULT_CIRCLE_ID, DEFAULT_CIRCLE_LABEL, isReservedCircleName, isDefaultCircle } from './state';
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
  it('initializes with General circle', () => {
    const store = createLoungeStore();
    const state = store.getState();
    expect(state.categories).toHaveLength(1);
    expect(state.categories[0]).toEqual({ id: DEFAULT_CIRCLE_ID, label: DEFAULT_CIRCLE_LABEL });
    expect(state.collapsed.size).toBe(0);
    expect(state.selectedAgentId).toBeNull();
    expect(state.selectedProjectId).toBeNull();
  });

  describe('deriveCategories', () => {
    it('creates one category per project plus General', () => {
      const store = createLoungeStore();
      store.getState().deriveCategories([
        makeProject({ id: 'proj-1', name: 'Project One' }),
        makeProject({ id: 'proj-2', name: 'Project Two' }),
      ]);
      const { categories } = store.getState();
      expect(categories).toHaveLength(3);
      expect(categories[0]).toEqual({ id: 'project:proj-1', label: 'Project One', projectId: 'proj-1' });
      expect(categories[1]).toEqual({ id: 'project:proj-2', label: 'Project Two', projectId: 'proj-2' });
      expect(categories[2]).toEqual({ id: DEFAULT_CIRCLE_ID, label: DEFAULT_CIRCLE_LABEL });
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

  describe('moveAgent', () => {
    it('adds an override for the agent', () => {
      const store = createLoungeStore();
      store.getState().moveAgent('agent-1', 'project:proj-2');
      expect(store.getState().agentCategoryOverrides['agent-1']).toBe('project:proj-2');
    });

    it('overwrites previous override', () => {
      const store = createLoungeStore();
      store.getState().moveAgent('agent-1', 'project:proj-2');
      store.getState().moveAgent('agent-1', 'project:proj-3');
      expect(store.getState().agentCategoryOverrides['agent-1']).toBe('project:proj-3');
    });

    it('does not affect other agents', () => {
      const store = createLoungeStore();
      store.getState().moveAgent('agent-1', 'project:proj-2');
      store.getState().moveAgent('agent-2', 'project:proj-3');
      expect(store.getState().agentCategoryOverrides['agent-1']).toBe('project:proj-2');
      expect(store.getState().agentCategoryOverrides['agent-2']).toBe('project:proj-3');
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

  it('falls unmatched agents into General when present', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
      { id: DEFAULT_CIRCLE_ID, label: DEFAULT_CIRCLE_LABEL },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
      makeAgent({ id: 'a2', projectId: 'unknown' }),
    ];

    const grouped = groupAgentsByCategory(agents, categories);
    expect(grouped.get('project:p1')).toHaveLength(1);
    expect(grouped.get(DEFAULT_CIRCLE_ID)).toHaveLength(1);
  });

  it('drops unmatched agents when General is absent', () => {
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

  it('respects overrides to move agent to a different category', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
      { id: 'project:p2', label: 'P2', projectId: 'p2' },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
      makeAgent({ id: 'a2', projectId: 'p1' }),
    ];

    const overrides = { a2: 'project:p2' };
    const grouped = groupAgentsByCategory(agents, categories, overrides);
    expect(grouped.get('project:p1')).toHaveLength(1);
    expect(grouped.get('project:p2')).toHaveLength(1);
    expect(grouped.get('project:p2')![0].id).toBe('a2');
  });

  it('ignores overrides pointing to invalid categories', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
    ];

    const overrides = { a1: 'project:nonexistent' };
    const grouped = groupAgentsByCategory(agents, categories, overrides);
    // Falls back to project-based grouping
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

describe('default circle (General)', () => {
  it('isDefaultCircle returns true for the default circle ID', () => {
    expect(isDefaultCircle(DEFAULT_CIRCLE_ID)).toBe(true);
    expect(isDefaultCircle('project:p1')).toBe(false);
    expect(isDefaultCircle('circle:1')).toBe(false);
  });

  it('renameCategory is a no-op on the default circle', () => {
    const store = createLoungeStore();
    store.getState().renameCategory(DEFAULT_CIRCLE_ID, 'Hacked');
    const general = store.getState().categories.find((c) => c.id === DEFAULT_CIRCLE_ID);
    expect(general!.label).toBe(DEFAULT_CIRCLE_LABEL);
  });

  it('renameCategory rejects reserved names on other circles', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([makeProject({ id: 'proj-1', name: 'MyProject' })]);
    store.getState().renameCategory('project:proj-1', 'General');
    expect(store.getState().categories[0].label).toBe('MyProject');
    // case-insensitive
    store.getState().renameCategory('project:proj-1', 'GENERAL');
    expect(store.getState().categories[0].label).toBe('MyProject');
  });

  it('General is always last after deriveCategories', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([
      makeProject({ id: 'proj-1' }),
      makeProject({ id: 'proj-2' }),
    ]);
    const cats = store.getState().categories;
    expect(cats[cats.length - 1].id).toBe(DEFAULT_CIRCLE_ID);
  });

  it('agents with no matching category fall into General', () => {
    const categories: LoungeCategory[] = [
      { id: 'project:p1', label: 'P1', projectId: 'p1' },
      { id: DEFAULT_CIRCLE_ID, label: DEFAULT_CIRCLE_LABEL },
    ];
    const agents = [
      makeAgent({ id: 'a1', projectId: 'p1' }),
      makeAgent({ id: 'a2', projectId: 'unknown-project' }),
    ];

    const grouped = groupAgentsByCategory(agents, categories);
    expect(grouped.get('project:p1')).toHaveLength(1);
    expect(grouped.get(DEFAULT_CIRCLE_ID)).toHaveLength(1);
    expect(grouped.get(DEFAULT_CIRCLE_ID)![0].id).toBe('a2');
  });
});

describe('isReservedCircleName', () => {
  it('matches "general" case-insensitively', () => {
    expect(isReservedCircleName('general')).toBe(true);
    expect(isReservedCircleName('General')).toBe(true);
    expect(isReservedCircleName('GENERAL')).toBe(true);
    expect(isReservedCircleName(' General ')).toBe(true);
  });

  it('does not match non-reserved names', () => {
    expect(isReservedCircleName('My Circle')).toBe(false);
    expect(isReservedCircleName('generals')).toBe(false);
  });
});

describe('addCircle', () => {
  it('adds a custom circle and returns its ID', () => {
    const store = createLoungeStore();
    const id = store.getState().addCircle('My Circle');
    expect(id).toBe('circle:1');
    expect(store.getState().customCircles).toHaveLength(1);
    expect(store.getState().customCircles[0]).toEqual({ id: 'circle:1', label: 'My Circle' });
  });

  it('inserts custom circle before General in categories', () => {
    const store = createLoungeStore();
    store.getState().addCircle('Team Chat');
    const cats = store.getState().categories;
    expect(cats[cats.length - 1].id).toBe(DEFAULT_CIRCLE_ID);
    expect(cats[cats.length - 2].label).toBe('Team Chat');
  });

  it('increments nextCircleId', () => {
    const store = createLoungeStore();
    store.getState().addCircle('A');
    store.getState().addCircle('B');
    expect(store.getState().nextCircleId).toBe(3);
    expect(store.getState().customCircles).toHaveLength(2);
  });

  it('rejects reserved names and returns empty string', () => {
    const store = createLoungeStore();
    const id = store.getState().addCircle('General');
    expect(id).toBe('');
    expect(store.getState().customCircles).toHaveLength(0);
  });

  it('preserves custom circles across deriveCategories', () => {
    const store = createLoungeStore();
    store.getState().addCircle('Favorites');
    store.getState().deriveCategories([makeProject({ id: 'proj-1' })]);

    const cats = store.getState().categories;
    expect(cats.find((c) => c.label === 'Favorites')).toBeDefined();
    expect(cats[cats.length - 1].id).toBe(DEFAULT_CIRCLE_ID);
  });

  it('agents can be moved to custom circles', () => {
    const store = createLoungeStore();
    const circleId = store.getState().addCircle('VIPs');
    store.getState().deriveCategories([makeProject({ id: 'p1' })]);

    const categories = store.getState().categories;
    const agents = [makeAgent({ id: 'a1', projectId: 'p1' })];
    const overrides = { a1: circleId };

    const grouped = groupAgentsByCategory(agents, categories, overrides);
    expect(grouped.get(circleId)).toHaveLength(1);
    expect(grouped.get('project:p1')).toHaveLength(0);
  });
});

describe('reorderCategory', () => {
  it('moves a category before the target', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([
      makeProject({ id: 'p1', name: 'P1' }),
      makeProject({ id: 'p2', name: 'P2' }),
      makeProject({ id: 'p3', name: 'P3' }),
    ]);

    // Move p3 before p1
    store.getState().reorderCategory('project:p3', 'project:p1');
    const ids = store.getState().categories.map((c) => c.id);
    expect(ids).toEqual(['project:p3', 'project:p1', 'project:p2', DEFAULT_CIRCLE_ID]);
  });

  it('keeps General at the end after reorder', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([
      makeProject({ id: 'p1' }),
      makeProject({ id: 'p2' }),
    ]);
    store.getState().reorderCategory('project:p2', 'project:p1');
    const cats = store.getState().categories;
    expect(cats[cats.length - 1].id).toBe(DEFAULT_CIRCLE_ID);
  });

  it('is a no-op when dragging General', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([makeProject({ id: 'p1' })]);
    const before = store.getState().categories.map((c) => c.id);
    store.getState().reorderCategory(DEFAULT_CIRCLE_ID, 'project:p1');
    const after = store.getState().categories.map((c) => c.id);
    expect(after).toEqual(before);
  });

  it('is a no-op when dropping onto General', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([makeProject({ id: 'p1' })]);
    const before = store.getState().categories.map((c) => c.id);
    store.getState().reorderCategory('project:p1', DEFAULT_CIRCLE_ID);
    const after = store.getState().categories.map((c) => c.id);
    expect(after).toEqual(before);
  });

  it('is a no-op for same category', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([makeProject({ id: 'p1' })]);
    const before = store.getState().categories.map((c) => c.id);
    store.getState().reorderCategory('project:p1', 'project:p1');
    const after = store.getState().categories.map((c) => c.id);
    expect(after).toEqual(before);
  });

  it('persists order across deriveCategories', () => {
    const store = createLoungeStore();
    store.getState().deriveCategories([
      makeProject({ id: 'p1', name: 'P1' }),
      makeProject({ id: 'p2', name: 'P2' }),
    ]);
    store.getState().reorderCategory('project:p2', 'project:p1');

    // Re-derive — order should be preserved
    store.getState().deriveCategories([
      makeProject({ id: 'p1', name: 'P1' }),
      makeProject({ id: 'p2', name: 'P2' }),
    ]);
    const ids = store.getState().categories.map((c) => c.id);
    expect(ids).toEqual(['project:p2', 'project:p1', DEFAULT_CIRCLE_ID]);
  });
});
