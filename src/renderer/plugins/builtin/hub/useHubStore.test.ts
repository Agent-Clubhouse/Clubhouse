import { describe, it, expect, beforeEach } from 'vitest';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { createHubStore, resetHubIdCounter, type HubInstanceData } from './useHubStore';
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
    resetHubIdCounter(0);
  });

  // ── Initial state ─────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with a single hub containing a single leaf', () => {
      const store = createHubStore('hub');
      expect(store.getState().hubs).toHaveLength(1);
      expect(store.getState().hubs[0].paneTree.type).toBe('leaf');
    });

    it('activeHubId matches the initial hub', () => {
      const store = createHubStore('hub');
      expect(store.getState().activeHubId).toBe(store.getState().hubs[0].id);
    });

    it('paneTree is synced from active hub', () => {
      const store = createHubStore('hub');
      expect(store.getState().paneTree).toBe(store.getState().hubs[0].paneTree);
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
    it('loads multi-hub instances from storage', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [
        { id: 'hub_inst_10', name: 'test-hub-1', paneTree: { type: 'leaf', id: 'hub_42', agentId: 'a1' } },
        { id: 'hub_inst_11', name: 'test-hub-2', paneTree: { type: 'leaf', id: 'hub_43', agentId: 'a2' } },
      ];
      storage.data.set('hub-instances', instances);
      storage.data.set('hub-active-id', 'hub_inst_11');

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().hubs).toHaveLength(2);
      expect(store.getState().activeHubId).toBe('hub_inst_11');
      expect(store.getState().paneTree).toEqual({ type: 'leaf', id: 'hub_43', agentId: 'a2' });
    });

    it('migrates legacy single-tree format', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const savedTree: LeafPane = { type: 'leaf', id: 'hub_42', agentId: 'a1' };
      storage.data.set('hub-pane-tree', savedTree);

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().hubs).toHaveLength(1);
      expect(store.getState().hubs[0].paneTree).toEqual(savedTree);
    });

    it('falls back to fresh hub on null', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().hubs).toHaveLength(1);
      expect(store.getState().hubs[0].paneTree.type).toBe('leaf');
    });

    it('falls back to fresh hub on invalid data', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      storage.data.set('hub-instances', { type: 'bogus' });

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().hubs).toHaveLength(1);
    });

    it('falls back to fresh hub on error', async () => {
      const store = createHubStore('hub');
      const storage: ScopedStorage = {
        read: async () => { throw new Error('disk error'); },
        write: async () => {},
        delete: async () => {},
        list: async () => [],
      };

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().loaded).toBe(true);
      expect(store.getState().hubs).toHaveLength(1);
    });

    it('syncs pane counter to loaded tree', async () => {
      resetPaneCounter(0);
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [{
        id: 'hub_inst_1', name: 'test', paneTree: {
          type: 'split', id: 'hub_20', direction: 'horizontal',
          children: [
            { type: 'leaf', id: 'hub_18', agentId: null },
            { type: 'leaf', id: 'hub_19', agentId: null },
          ],
        },
      }];
      storage.data.set('hub-instances', instances);

      await store.getState().loadHub(storage, 'hub');

      // Split after load should produce IDs above 20
      store.getState().splitPane('hub_18', 'horizontal', 'hub');
      const leaves = collectLeaves(store.getState().paneTree);
      const ids = leaves.map((l) => parseInt(l.id.split('_')[1], 10));
      expect(Math.max(...ids)).toBeGreaterThan(20);
    });

    it('restores saved active hub id', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [
        { id: 'hub_inst_1', name: 'first', paneTree: { type: 'leaf', id: 'hub_1', agentId: null } },
        { id: 'hub_inst_2', name: 'second', paneTree: { type: 'leaf', id: 'hub_2', agentId: null } },
      ];
      storage.data.set('hub-instances', instances);
      storage.data.set('hub-active-id', 'hub_inst_2');

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().activeHubId).toBe('hub_inst_2');
    });

    it('falls back to first hub when saved active id is invalid', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [
        { id: 'hub_inst_1', name: 'first', paneTree: { type: 'leaf', id: 'hub_1', agentId: null } },
      ];
      storage.data.set('hub-instances', instances);
      storage.data.set('hub-active-id', 'nonexistent');

      await store.getState().loadHub(storage, 'hub');

      expect(store.getState().activeHubId).toBe('hub_inst_1');
    });

    it('sanitizes cross-project references when currentProjectId is provided', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [
        {
          id: 'hub_inst_1', name: 'test',
          paneTree: {
            type: 'split', id: 'hub_10', direction: 'horizontal' as const,
            children: [
              { type: 'leaf', id: 'hub_11', agentId: 'a1', projectId: 'proj-1' },
              { type: 'leaf', id: 'hub_12', agentId: 'a2', projectId: 'proj-other' },
            ],
          },
        },
      ];
      storage.data.set('hub-instances', instances);

      await store.getState().loadHub(storage, 'hub', 'proj-1');

      const leaves = collectLeaves(store.getState().paneTree);
      // Matching projectId kept
      expect(leaves[0].agentId).toBe('a1');
      expect(leaves[0].projectId).toBe('proj-1');
      // Mismatched projectId cleared
      expect(leaves[1].agentId).toBeNull();
      expect(leaves[1].projectId).toBeUndefined();
    });

    it('does not sanitize when currentProjectId is omitted', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      const instances: HubInstanceData[] = [
        {
          id: 'hub_inst_1', name: 'test',
          paneTree: { type: 'leaf', id: 'hub_11', agentId: 'a2', projectId: 'proj-other' },
        },
      ];
      storage.data.set('hub-instances', instances);

      await store.getState().loadHub(storage, 'hub');

      const leaf = store.getState().paneTree as LeafPane;
      expect(leaf.agentId).toBe('a2');
      expect(leaf.projectId).toBe('proj-other');
    });

    it('sanitizes legacy tree during migration with currentProjectId', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();
      storage.data.set('hub-pane-tree', { type: 'leaf', id: 'hub_42', agentId: 'a1', projectId: 'wrong-proj' });

      await store.getState().loadHub(storage, 'hub', 'my-proj');

      const leaf = store.getState().hubs[0].paneTree as LeafPane;
      expect(leaf.agentId).toBeNull();
      expect(leaf.projectId).toBeUndefined();
    });
  });

  // ── saveHub ───────────────────────────────────────────────────────────

  describe('saveHub', () => {
    it('writes hub instances and active id', async () => {
      const store = createHubStore('hub');
      const storage = createMockStorage();

      await store.getState().saveHub(storage);

      expect(storage.data.has('hub-instances')).toBe(true);
      expect(storage.data.has('hub-active-id')).toBe(true);
      const saved = storage.data.get('hub-instances') as HubInstanceData[];
      expect(saved).toHaveLength(1);
      expect(saved[0].paneTree).toEqual(store.getState().paneTree);
    });
  });

  // ── Hub management ─────────────────────────────────────────────────

  describe('addHub', () => {
    it('adds a new hub and activates it', () => {
      const store = createHubStore('hub');
      const firstId = store.getState().activeHubId;
      const newId = store.getState().addHub('hub');
      expect(store.getState().hubs).toHaveLength(2);
      expect(store.getState().activeHubId).toBe(newId);
      expect(newId).not.toBe(firstId);
    });

    it('new hub has a generated name', () => {
      const store = createHubStore('hub');
      store.getState().addHub('hub');
      const newHub = store.getState().hubs[1];
      expect(newHub.name).toMatch(/^[a-z]+-[a-z]+$/);
    });
  });

  describe('removeHub', () => {
    it('removes a hub and switches active', () => {
      const store = createHubStore('hub');
      store.getState().addHub('hub');
      const first = store.getState().hubs[0];
      const second = store.getState().hubs[1];
      store.getState().removeHub(second.id, 'hub');
      expect(store.getState().hubs).toHaveLength(1);
      expect(store.getState().activeHubId).toBe(first.id);
    });

    it('resets when removing the last hub', () => {
      const store = createHubStore('hub');
      const id = store.getState().hubs[0].id;
      store.getState().removeHub(id, 'hub');
      expect(store.getState().hubs).toHaveLength(1);
      expect(store.getState().hubs[0].id).not.toBe(id);
    });

    it('keeps active if a different hub is removed', () => {
      const store = createHubStore('hub');
      const firstId = store.getState().hubs[0].id;
      store.getState().addHub('hub');
      store.getState().setActiveHub(firstId);
      const secondId = store.getState().hubs[1].id;
      store.getState().removeHub(secondId, 'hub');
      expect(store.getState().activeHubId).toBe(firstId);
    });
  });

  describe('renameHub', () => {
    it('renames a hub', () => {
      const store = createHubStore('hub');
      const id = store.getState().hubs[0].id;
      store.getState().renameHub(id, 'my-custom-hub');
      expect(store.getState().hubs[0].name).toBe('my-custom-hub');
    });
  });

  describe('setActiveHub', () => {
    it('switches the active hub', () => {
      const store = createHubStore('hub');
      store.getState().addHub('hub');
      const first = store.getState().hubs[0];
      store.getState().setActiveHub(first.id);
      expect(store.getState().activeHubId).toBe(first.id);
      expect(store.getState().paneTree).toBe(first.paneTree);
    });

    it('ignores invalid hub id', () => {
      const store = createHubStore('hub');
      const activeId = store.getState().activeHubId;
      store.getState().setActiveHub('nonexistent');
      expect(store.getState().activeHubId).toBe(activeId);
    });
  });

  // ── Pane operations (scoped to active hub) ─────────────────────────

  describe('splitPane', () => {
    it('splits a pane in the active hub', () => {
      const store = createHubStore('hub');
      const id = store.getState().paneTree.id;
      store.getState().splitPane(id, 'horizontal', 'hub');
      expect(collectLeaves(store.getState().paneTree)).toHaveLength(2);
    });

    it('does not affect other hubs', () => {
      const store = createHubStore('hub');
      const firstHubId = store.getState().hubs[0].id;
      store.getState().addHub('hub');
      // Active is now the second hub
      const paneId = store.getState().paneTree.id;
      store.getState().splitPane(paneId, 'horizontal', 'hub');

      // Switch back to first hub
      store.getState().setActiveHub(firstHubId);
      expect(collectLeaves(store.getState().paneTree)).toHaveLength(1);
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
    it('clears unknown agents from all hubs', () => {
      const store = createHubStore('hub');
      const id1 = store.getState().paneTree.id;
      store.getState().assignAgent(id1, 'agent-1');

      store.getState().addHub('hub');
      const id2 = store.getState().paneTree.id;
      store.getState().assignAgent(id2, 'agent-1');

      store.getState().validateAgents(new Set(['agent-2']));

      // Both hubs should have agent cleared
      for (const hub of store.getState().hubs) {
        expect((hub.paneTree as LeafPane).agentId).toBeNull();
      }
    });
  });

  describe('removePanesByAgent', () => {
    it('clears matching agent from all hubs', () => {
      const store = createHubStore('hub');
      const id1 = store.getState().paneTree.id;
      store.getState().assignAgent(id1, 'agent-1');

      store.getState().addHub('hub');
      const id2 = store.getState().paneTree.id;
      store.getState().assignAgent(id2, 'agent-1');

      store.getState().removePanesByAgent('agent-1');

      for (const hub of store.getState().hubs) {
        expect((hub.paneTree as LeafPane).agentId).toBeNull();
      }
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
    it('load → add hub → split → assign → save → new store load → verify', async () => {
      const storage = createMockStorage();
      const store1 = createHubStore('hub');

      await store1.getState().loadHub(storage, 'hub');

      // Add a second hub
      store1.getState().addHub('hub');
      const hub2Id = store1.getState().activeHubId;

      // Split and assign in second hub
      const rootId = store1.getState().paneTree.id;
      store1.getState().splitPane(rootId, 'horizontal', 'hub');
      const leaves = collectLeaves(store1.getState().paneTree);
      store1.getState().assignAgent(leaves[0].id, 'agent-1', 'proj-1');
      store1.getState().assignAgent(leaves[1].id, 'agent-2', 'proj-2');

      // Save
      await store1.getState().saveHub(storage);

      // Load into a new store
      resetPaneCounter(0);
      resetHubIdCounter(0);
      const store2 = createHubStore('hub');
      await store2.getState().loadHub(storage, 'hub');

      expect(store2.getState().hubs).toHaveLength(2);
      expect(store2.getState().activeHubId).toBe(hub2Id);

      const leaves2 = collectLeaves(store2.getState().paneTree);
      expect(leaves2).toHaveLength(2);
      expect(leaves2[0].agentId).toBe('agent-1');
      expect(leaves2[0].projectId).toBe('proj-1');
      expect(leaves2[1].agentId).toBe('agent-2');
      expect(leaves2[1].projectId).toBe('proj-2');
    });
  });

  // ── Agents in multiple hubs ─────────────────────────────────────────

  describe('agents across hubs', () => {
    it('same agent can appear in multiple hubs', () => {
      const store = createHubStore('hub');
      const firstPaneId = store.getState().paneTree.id;
      store.getState().assignAgent(firstPaneId, 'agent-1');

      store.getState().addHub('hub');
      const secondPaneId = store.getState().paneTree.id;
      store.getState().assignAgent(secondPaneId, 'agent-1');

      // Both hubs should have agent-1
      expect((store.getState().hubs[0].paneTree as LeafPane).agentId).toBe('agent-1');
      expect((store.getState().hubs[1].paneTree as LeafPane).agentId).toBe('agent-1');
    });
  });

  // ── Scoped counters (no cross-store ID collisions) ─────────────────

  describe('per-store scoped counters', () => {
    it('two stores have independent pane counters', () => {
      const storeA = createHubStore('hub');
      const storeB = createHubStore('hub');

      // Both start with hub_1 as their initial leaf (independent counters)
      const leafA = storeA.getState().paneTree as LeafPane;
      const leafB = storeB.getState().paneTree as LeafPane;

      // The initial pane IDs are generated independently per store
      expect(leafA.id).toBe(leafB.id); // both hub_1 from their own counter

      // Splitting in storeA doesn't affect storeB's counter
      storeA.getState().splitPane(leafA.id, 'horizontal', 'hub');
      const leavesA = collectLeaves(storeA.getState().paneTree);

      storeB.getState().splitPane(leafB.id, 'horizontal', 'hub');
      const leavesB = collectLeaves(storeB.getState().paneTree);

      // Both stores should have the same ID pattern (independent counters)
      expect(leavesA.map((l) => l.id)).toEqual(leavesB.map((l) => l.id));
    });

    it('two stores have independent hub ID counters', () => {
      const storeA = createHubStore('hub');
      const storeB = createHubStore('hub');

      // Both initial hubs should have hub_inst_1
      expect(storeA.getState().hubs[0].id).toBe('hub_inst_1');
      expect(storeB.getState().hubs[0].id).toBe('hub_inst_1');

      // Adding a hub in storeA doesn't affect storeB
      storeA.getState().addHub('hub');
      expect(storeA.getState().hubs).toHaveLength(2);
      expect(storeA.getState().hubs[1].id).toBe('hub_inst_2');

      // storeB's next hub should also be hub_inst_2 (independent counter)
      storeB.getState().addHub('hub');
      expect(storeB.getState().hubs[1].id).toBe('hub_inst_2');
    });
  });
});
