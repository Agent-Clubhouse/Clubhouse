import { describe, it, expect, beforeEach } from 'vitest';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { createHubStore } from './useHubStore';
import { resetPaneCounter, collectLeaves, type PaneNode, type LeafPane, type SplitPane } from './pane-tree';

function createMockStorage(): ScopedStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    async read(key: string) { return data.get(key); },
    async write(key: string, value: unknown) { data.set(key, value); },
    async delete(key: string) { data.delete(key); },
    async list() { return Array.from(data.keys()); },
  };
}

describe('useHubStore', () => {
  beforeEach(() => {
    resetPaneCounter(0);
  });

  // ── Initial state ─────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with a single leaf', () => {
      const store = createHubStore('hub');
      const { paneTree } = store.getState();
      expect(paneTree.type).toBe('leaf');
    });

    it('focusedPaneId matches the initial leaf', () => {
      const store = createHubStore('hub');
      const { paneTree, focusedPaneId } = store.getState();
      expect(focusedPaneId).toBe(paneTree.id);
    });

    it('loaded is false initially', () => {
      const store = createHubStore('hub');
      expect(store.getState().loaded).toBe(false);
    });

    it('drag state is null initially', () => {
      const store = createHubStore('hub');
      expect(store.getState().dragSourcePaneId).toBeNull();
      expect(store.getState().dragOverPaneId).toBeNull();
    });
  });

  // ── loadHub ───────────────────────────────────────────────────────────

  describe('loadHub', () => {
    it('loads a valid tree from storage', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const savedTree: LeafPane = { type: 'leaf', id: 'hub_42', agentId: 'a1' };
      storage.data.set('hub-pane-tree', savedTree);

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().paneTree).toEqual(savedTree);
      expect(store.getState().focusedPaneId).toBe('hub_42');
    });

    it('falls back to fresh leaf on null', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().paneTree.type).toBe('leaf');
    });

    it('falls back to fresh leaf on invalid data', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      storage.data.set('hub-pane-tree', { type: 'bogus' });

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().paneTree.type).toBe('leaf');
    });

    it('falls back to fresh leaf on error', async () => {
      const store = createHubStore('hub');
      const storage: ScopedStorage = {
        read: async () => { throw new Error('disk error'); },
        write: async () => {},
        delete: async () => {},
        list: async () => [],
      };

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().paneTree.type).toBe('leaf');
    });

    it('syncs counter to loaded tree', async () => {
      resetPaneCounter(0);
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const savedTree: SplitPane = {
        type: 'split', id: 'hub_20', direction: 'horizontal',
        children: [
          { type: 'leaf', id: 'hub_18', agentId: null },
          { type: 'leaf', id: 'hub_19', agentId: null },
        ],
      };
      storage.data.set('hub-pane-tree', savedTree);

      await store.getState().loadHub(storage, 'hub');

      // Split after load should produce IDs above 20
      store.getState().splitPane('hub_18', 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      const ids = leaves.map((l) => parseInt(l.id.split('_')[1], 10));
      expect(Math.max(...ids)).toBeGreaterThan(20);
    });
  });

  // ── saveHub ───────────────────────────────────────────────────────────

  describe('saveHub', () => {
    it('writes to hub-pane-tree key', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();

      await store.getState().saveHub(storage);

      expect(storage.data.has('hub-pane-tree')).toBe(true);
      expect(storage.data.get('hub-pane-tree')).toEqual(store.getState().paneTree);
    });
  });

  // ── Store actions ─────────────────────────────────────────────────────

  describe('splitPane', () => {
    it('splits a pane and increases leaf count', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      expect(collectLeaves(store.getState().paneTree)).toHaveLength(2);
    });
  });

  describe('closePane', () => {
    it('closing last pane creates fresh leaf', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().closePane(id, 'hub');
      expect(store.getState().paneTree.type).toBe('leaf');
      expect(store.getState().paneTree.id).not.toBe(id);
    });

    it('updates focusedPaneId when focused pane is closed', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      // Focus the first leaf, then close it
      store.getState().setFocusedPane(leaves[0].id);
      store.getState().closePane(leaves[0].id, 'hub');
      expect(store.getState().focusedPaneId).toBe(leaves[1].id);
    });

    it('keeps focusedPaneId when non-focused pane is closed', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      store.getState().setFocusedPane(leaves[0].id);
      store.getState().closePane(leaves[1].id, 'hub');
      expect(store.getState().focusedPaneId).toBe(leaves[0].id);
    });
  });

  describe('assignAgent', () => {
    it('assigns agent to a pane', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().assignAgent(id, 'agent-1', 'proj-1');
      const leaf = store.getState().paneTree as LeafPane;
      expect(leaf.agentId).toBe('agent-1');
      expect(leaf.projectId).toBe('proj-1');
    });
  });

  describe('swapPanes', () => {
    it('swaps agents between panes', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      store.getState().assignAgent(leaves[0].id, 'agent-1');
      store.getState().assignAgent(leaves[1].id, 'agent-2');
      store.getState().swapPanes(leaves[0].id, leaves[1].id);

      const updated = collectLeaves(store.getState().paneTree);
      expect(updated[0].agentId).toBe('agent-2');
      expect(updated[1].agentId).toBe('agent-1');
    });
  });

  describe('validateAgents', () => {
    it('clears unknown agents from tree', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().assignAgent(id, 'agent-1');
      store.getState().validateAgents(new Set(['agent-2']));
      expect((store.getState().paneTree as LeafPane).agentId).toBeNull();
    });
  });

  describe('removePanesByAgent', () => {
    it('clears matching agent from all panes', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().assignAgent(id, 'agent-1');
      store.getState().removePanesByAgent('agent-1');
      expect((store.getState().paneTree as LeafPane).agentId).toBeNull();
    });
  });

  describe('drag state', () => {
    it('setDragSource and setDragOver update state', () => {
      const store = createHubStore('hub');
      store.getState().setDragSource('pane-1');
      store.getState().setDragOver('pane-2');
      expect(store.getState().dragSourcePaneId).toBe('pane-1');
      expect(store.getState().dragOverPaneId).toBe('pane-2');
    });

    it('setDragSource/setDragOver accept null to clear', () => {
      const store = createHubStore('hub');
      store.getState().setDragSource('pane-1');
      store.getState().setDragSource(null);
      expect(store.getState().dragSourcePaneId).toBeNull();
    });
  });

  // ── setSplitRatio ───────────────────────────────────────────────────

  describe('setSplitRatio', () => {
    it('updates the ratio on a split', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const splitId = store.getState().paneTree.id;
      store.getState().setSplitRatio(splitId, 0.7);
      const tree = store.getState().paneTree as SplitPane;
      expect(tree.ratio).toBeCloseTo(0.7);
    });

    it('clamps the ratio', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const splitId = store.getState().paneTree.id;
      store.getState().setSplitRatio(splitId, 0.01);
      const tree = store.getState().paneTree as SplitPane;
      expect(tree.ratio).toBeCloseTo(0.15);
    });
  });

  // ── toggleZoom ─────────────────────────────────────────────────────

  describe('toggleZoom', () => {
    it('sets zoomedPaneId', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().toggleZoom(id);
      expect(store.getState().zoomedPaneId).toBe(id);
    });

    it('unsets zoomedPaneId on second call', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().toggleZoom(id);
      store.getState().toggleZoom(id);
      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('cleared when zoomed pane is closed', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      store.getState().toggleZoom(leaves[0].id);
      expect(store.getState().zoomedPaneId).toBe(leaves[0].id);
      store.getState().closePane(leaves[0].id, 'hub');
      expect(store.getState().zoomedPaneId).toBeNull();
    });
  });

  // ── Round-trip persistence ────────────────────────────────────────────

  describe('round-trip', () => {
    it('load → split → assign → save → new store load → verify', async () => {
      const storage = createMockStorage();
      const store1 = createHubStore('hub');

      // Load fresh, split, assign
      await store1.getState().loadHub(storage, 'hub');
      const rootId = store1.getState().paneTree.id;
      store1.getState().splitPane(rootId, 'horizontal', 'hub');
      const leaves1 = collectLeaves(store1.getState().paneTree);
      store1.getState().assignAgent(leaves1[0].id, 'agent-1', 'proj-1');
      store1.getState().assignAgent(leaves1[1].id, 'agent-2', 'proj-2');

      // Save
      await store1.getState().saveHub(storage);

      // Load into a new store
      resetPaneCounter(0);
      const store2 = createHubStore('hub');
      await store2.getState().loadHub(storage, 'hub');

      const leaves2 = collectLeaves(store2.getState().paneTree);
      expect(leaves2).toHaveLength(2);
      expect(leaves2[0].agentId).toBe('agent-1');
      expect(leaves2[0].projectId).toBe('proj-1');
      expect(leaves2[1].agentId).toBe('agent-2');
      expect(leaves2[1].projectId).toBe('proj-2');
    });
  });
});
