import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock localStorage
const storage = new Map<string, string>();
const localStorageMock = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  removeItem: vi.fn((key: string) => storage.delete(key)),
  clear: vi.fn(() => storage.clear()),
  get length() { return storage.size; },
  key: vi.fn((_i: number) => null),
};
vi.stubGlobal('localStorage', localStorageMock);

// Mock layoutStore to prevent issues with its module-level loadFromStorage
vi.mock('./layoutStore', () => ({
  useLayoutStore: {
    getState: () => ({
      removeHubSplitRatio: vi.fn(),
    }),
  },
}));

import { useHubStore, PaneNode } from './hubStore';

function getState() {
  return useHubStore.getState();
}

describe('hubStore', () => {
  beforeEach(() => {
    storage.clear();
    vi.clearAllMocks();
    // Reset the store to initial state
    useHubStore.setState({
      paneTree: null,
      focusedPaneId: null,
      activeProjectId: null,
    });
  });

  describe('loadHub', () => {
    it('fresh project creates a single empty leaf pane', () => {
      getState().loadHub('proj_1', new Set());
      const tree = getState().paneTree;
      expect(tree).not.toBeNull();
      expect(tree!.type).toBe('leaf');
      if (tree!.type === 'leaf') {
        expect(tree!.agentId).toBeNull();
      }
      expect(getState().focusedPaneId).toBe(tree!.id);
      expect(getState().activeProjectId).toBe('proj_1');
    });

    it('restores tree from localStorage and syncs paneCounter', () => {
      const savedTree: PaneNode = {
        id: 'pane_10',
        type: 'split',
        direction: 'horizontal',
        children: [
          { id: 'pane_11', type: 'leaf', agentId: 'agent_a' },
          { id: 'pane_12', type: 'leaf', agentId: null },
        ],
      };
      storage.set('hub_layout_proj_2', JSON.stringify(savedTree));

      getState().loadHub('proj_2', new Set(['agent_a']));
      const tree = getState().paneTree;
      expect(tree).not.toBeNull();
      expect(tree!.type).toBe('split');

      // New pane IDs should not collide with restored ones (counter > 12)
      getState().splitPane(getState().focusedPaneId!, 'right');
      const updated = getState().paneTree!;
      const allIds = collectIds(updated);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it('validates agents, nulling unknown IDs', () => {
      const savedTree: PaneNode = {
        id: 'pane_20',
        type: 'split',
        direction: 'horizontal',
        children: [
          { id: 'pane_21', type: 'leaf', agentId: 'known_agent' },
          { id: 'pane_22', type: 'leaf', agentId: 'stale_agent' },
        ],
      };
      storage.set('hub_layout_proj_3', JSON.stringify(savedTree));

      getState().loadHub('proj_3', new Set(['known_agent']));
      const tree = getState().paneTree!;
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        const left = tree.children[0];
        const right = tree.children[1];
        if (left.type === 'leaf') expect(left.agentId).toBe('known_agent');
        if (right.type === 'leaf') expect(right.agentId).toBeNull();
      }
    });

    it('same project reloads just validate, does not reset', () => {
      getState().loadHub('proj_4', new Set());
      const firstTree = getState().paneTree;
      getState().assignAgent(firstTree!.id, 'agent_x');

      // Reload same project — should keep current tree, just validate
      getState().loadHub('proj_4', new Set(['agent_x']));
      const tree = getState().paneTree!;
      if (tree.type === 'leaf') {
        expect(tree.agentId).toBe('agent_x');
      }
    });
  });

  describe('splitPane', () => {
    beforeEach(() => {
      getState().loadHub('proj_split', new Set());
    });

    it('right: horizontal split, existing on left, new on right', () => {
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        expect(tree.direction).toBe('horizontal');
        expect(tree.children[0].id).toBe(rootId);
        expect(tree.children[1].type).toBe('leaf');
      }
    });

    it('left: horizontal split, new on left', () => {
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'left');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        expect(tree.direction).toBe('horizontal');
        expect(tree.children[1].id).toBe(rootId); // existing on right
        expect(tree.children[0].type).toBe('leaf'); // new on left
      }
    });

    it('down: vertical split', () => {
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'down');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        expect(tree.direction).toBe('vertical');
        expect(tree.children[0].id).toBe(rootId);
      }
    });

    it('up: vertical split, new on top', () => {
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'up');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        expect(tree.direction).toBe('vertical');
        expect(tree.children[1].id).toBe(rootId); // existing on bottom
      }
    });

    it('preserves agentId on existing leaf', () => {
      const rootId = getState().paneTree!.id;
      getState().assignAgent(rootId, 'agent_keep');
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        const existing = tree.children[0];
        if (existing.type === 'leaf') {
          expect(existing.agentId).toBe('agent_keep');
        }
      }
    });

    it('nested split on already-split tree', () => {
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'right');
      // Now split the left child down
      getState().splitPane(rootId, 'down');
      const tree = getState().paneTree!;
      // Root should be horizontal split
      expect(tree.type).toBe('split');
      if (tree.type === 'split') {
        // Left child should now be a vertical split
        expect(tree.children[0].type).toBe('split');
        if (tree.children[0].type === 'split') {
          expect(tree.children[0].direction).toBe('vertical');
        }
      }
    });

    it('non-existent paneId is a no-op', () => {
      const treeBefore = getState().paneTree;
      getState().splitPane('nonexistent_pane', 'right');
      expect(getState().paneTree).toEqual(treeBefore);
    });
  });

  describe('closePane', () => {
    it('single root leaf creates fresh empty pane (not null tree)', () => {
      getState().loadHub('proj_close', new Set());
      const rootId = getState().paneTree!.id;
      getState().closePane(rootId);
      const tree = getState().paneTree;
      expect(tree).not.toBeNull();
      expect(tree!.type).toBe('leaf');
      if (tree!.type === 'leaf') {
        expect(tree!.agentId).toBeNull();
      }
      // Should be a new ID
      expect(tree!.id).not.toBe(rootId);
    });

    it('one of two leaves promotes sibling to root', () => {
      getState().loadHub('proj_close2', new Set());
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        const rightId = tree.children[1].id;
        getState().closePane(rightId);
        const after = getState().paneTree!;
        expect(after.type).toBe('leaf');
        expect(after.id).toBe(rootId);
      }
    });

    it('nested tree: correct subtree promotion', () => {
      getState().loadHub('proj_close3', new Set());
      const rootId = getState().paneTree!.id;
      // Split right, then split right pane down
      getState().splitPane(rootId, 'right');
      let tree = getState().paneTree!;
      if (tree.type === 'split') {
        const rightId = tree.children[1].id;
        getState().splitPane(rightId, 'down');
        // Close the original left pane
        getState().closePane(rootId);
        tree = getState().paneTree!;
        // Root should now be the right subtree (vertical split)
        expect(tree.type).toBe('split');
        if (tree.type === 'split') {
          expect(tree.direction).toBe('vertical');
        }
      }
    });

    it('focuses first leaf of surviving subtree', () => {
      getState().loadHub('proj_close4', new Set());
      const rootId = getState().paneTree!.id;
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        // Close the right pane
        const rightId = tree.children[1].id;
        getState().closePane(rightId);
        expect(getState().focusedPaneId).toBe(rootId);
      }
    });
  });

  describe('assignAgent', () => {
    it('sets agentId on correct leaf', () => {
      getState().loadHub('proj_assign', new Set());
      const rootId = getState().paneTree!.id;
      getState().assignAgent(rootId, 'agent_1');
      const tree = getState().paneTree!;
      if (tree.type === 'leaf') {
        expect(tree.agentId).toBe('agent_1');
      }
    });

    it('does not affect other panes', () => {
      getState().loadHub('proj_assign2', new Set());
      const rootId = getState().paneTree!.id;
      getState().assignAgent(rootId, 'agent_orig');
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        const newPaneId = tree.children[1].id;
        getState().assignAgent(newPaneId, 'agent_new');
        const updated = getState().paneTree!;
        if (updated.type === 'split') {
          const left = updated.children[0];
          const right = updated.children[1];
          if (left.type === 'leaf') expect(left.agentId).toBe('agent_orig');
          if (right.type === 'leaf') expect(right.agentId).toBe('agent_new');
        }
      }
    });
  });

  describe('removePanesByAgent', () => {
    it('nulls matching agent, keeps others', () => {
      getState().loadHub('proj_remove', new Set());
      const rootId = getState().paneTree!.id;
      getState().assignAgent(rootId, 'agent_remove');
      getState().splitPane(rootId, 'right');
      const tree = getState().paneTree!;
      if (tree.type === 'split') {
        const rightId = tree.children[1].id;
        getState().assignAgent(rightId, 'agent_keep');
        getState().removePanesByAgent('agent_remove');
        const updated = getState().paneTree!;
        if (updated.type === 'split') {
          const left = updated.children[0];
          const right = updated.children[1];
          if (left.type === 'leaf') expect(left.agentId).toBeNull();
          if (right.type === 'leaf') expect(right.agentId).toBe('agent_keep');
        }
      }
    });
  });

  describe('validateAgents (via loadHub)', () => {
    it('deeply nested tree with mix of valid/invalid', () => {
      const deepTree: PaneNode = {
        id: 'pane_100',
        type: 'split',
        direction: 'horizontal',
        children: [
          {
            id: 'pane_101',
            type: 'split',
            direction: 'vertical',
            children: [
              { id: 'pane_102', type: 'leaf', agentId: 'valid_1' },
              { id: 'pane_103', type: 'leaf', agentId: 'invalid_1' },
            ],
          },
          {
            id: 'pane_104',
            type: 'split',
            direction: 'vertical',
            children: [
              { id: 'pane_105', type: 'leaf', agentId: 'invalid_2' },
              { id: 'pane_106', type: 'leaf', agentId: 'valid_2' },
            ],
          },
        ],
      };
      storage.set('hub_layout_proj_deep', JSON.stringify(deepTree));

      getState().loadHub('proj_deep', new Set(['valid_1', 'valid_2']));
      const tree = getState().paneTree!;
      const leaves = collectLeaves(tree);
      const byId = new Map(leaves.map((l) => [l.id, l]));
      expect((byId.get('pane_102') as any).agentId).toBe('valid_1');
      expect((byId.get('pane_103') as any).agentId).toBeNull();
      expect((byId.get('pane_105') as any).agentId).toBeNull();
      expect((byId.get('pane_106') as any).agentId).toBe('valid_2');
    });
  });
});

// Helpers

function collectIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [node.id, ...collectIds(node.children[0]), ...collectIds(node.children[1])];
}

function collectLeaves(node: PaneNode): PaneNode[] {
  if (node.type === 'leaf') return [node];
  return [...collectLeaves(node.children[0]), ...collectLeaves(node.children[1])];
}
