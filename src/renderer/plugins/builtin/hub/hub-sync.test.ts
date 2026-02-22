import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyHubMutation, broadcastHubState } from './hub-sync';
import { createHubStore } from './useHubStore';
import type { HubMutation } from '../../../../shared/types';
import { createLeaf, resetPaneCounter } from './pane-tree';
import { resetHubIdCounter } from './useHubStore';

describe('hub-sync', () => {
  let store: ReturnType<typeof createHubStore>;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetPaneCounter();
    resetHubIdCounter();
    store = createHubStore('hub');
    broadcastSpy = vi.fn();
    window.clubhouse.window.broadcastHubState = broadcastSpy;
  });

  describe('applyHubMutation', () => {
    it('applies split mutation', () => {
      const state = store.getState();
      const paneId = state.activeHub().focusedPaneId;
      const hubId = state.activeHubId;

      const mutation: HubMutation = {
        type: 'split',
        paneId,
        direction: 'horizontal',
        position: 'after',
      };

      applyHubMutation(store, hubId, mutation);

      const updated = store.getState().activeHub();
      expect(updated.paneTree.type).toBe('split');
    });

    it('applies close mutation', () => {
      const state = store.getState();
      const hubId = state.activeHubId;
      const paneId = state.activeHub().focusedPaneId;

      // First split to create two panes
      store.getState().splitPane(paneId, 'horizontal', 'hub');
      const afterSplit = store.getState().activeHub();
      expect(afterSplit.paneTree.type).toBe('split');

      // Close the original pane
      const mutation: HubMutation = { type: 'close', paneId };
      applyHubMutation(store, hubId, mutation);

      const updated = store.getState().activeHub();
      expect(updated.paneTree.type).toBe('leaf');
    });

    it('applies assign mutation', () => {
      const state = store.getState();
      const hubId = state.activeHubId;
      const paneId = state.activeHub().focusedPaneId;

      const mutation: HubMutation = {
        type: 'assign',
        paneId,
        agentId: 'agent-123',
        projectId: 'proj-456',
      };

      applyHubMutation(store, hubId, mutation);

      const updated = store.getState().activeHub();
      if (updated.paneTree.type === 'leaf') {
        expect(updated.paneTree.agentId).toBe('agent-123');
      }
    });

    it('applies zoom mutation', () => {
      const state = store.getState();
      const hubId = state.activeHubId;
      const paneId = state.activeHub().focusedPaneId;

      applyHubMutation(store, hubId, { type: 'zoom', paneId });
      expect(store.getState().activeHub().zoomedPaneId).toBe(paneId);

      // Toggle off
      applyHubMutation(store, hubId, { type: 'zoom', paneId });
      expect(store.getState().activeHub().zoomedPaneId).toBeNull();
    });

    it('applies focus mutation', () => {
      const state = store.getState();
      const hubId = state.activeHubId;
      const paneId = state.activeHub().focusedPaneId;

      // Split to create two panes
      store.getState().splitPane(paneId, 'horizontal', 'hub');

      const leaves = getAllLeaves(store.getState().activeHub().paneTree);
      const secondPane = leaves.find((l) => l.id !== paneId);
      expect(secondPane).toBeTruthy();

      applyHubMutation(store, hubId, { type: 'focus', paneId: secondPane!.id });
      expect(store.getState().activeHub().focusedPaneId).toBe(secondPane!.id);
    });

    it('broadcasts state after mutation', () => {
      const state = store.getState();
      const hubId = state.activeHubId;
      const paneId = state.activeHub().focusedPaneId;

      applyHubMutation(store, hubId, {
        type: 'assign',
        paneId,
        agentId: 'agent-1',
      });

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
        hubId,
        paneTree: expect.any(Object),
        focusedPaneId: expect.any(String),
      }));
    });
  });

  describe('broadcastHubState', () => {
    it('broadcasts current hub state', () => {
      const hubId = store.getState().activeHubId;
      broadcastHubState(store, hubId);

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.hubId).toBe(hubId);
      expect(snapshot.paneTree).toBeDefined();
      expect(snapshot.focusedPaneId).toBeDefined();
    });

    it('does nothing for non-existent hub', () => {
      broadcastHubState(store, 'nonexistent');
      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });
});

// Helper to collect all leaves from a pane tree
function getAllLeaves(tree: any): any[] {
  if (tree.type === 'leaf') return [tree];
  return [...getAllLeaves(tree.children[0]), ...getAllLeaves(tree.children[1])];
}
