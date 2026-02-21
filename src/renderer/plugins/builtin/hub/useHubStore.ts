import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import {
  PaneNode,
  createLeaf,
  splitPane as splitPaneOp,
  closePane as closePaneOp,
  assignAgent as assignAgentOp,
  swapPanes as swapPanesOp,
  removePanesByAgent as removePanesByAgentOp,
  validateAgents as validateAgentsOp,
  setSplitRatio as setSplitRatioOp,
  getFirstLeafId,
  findLeaf,
  syncCounterToTree,
} from './pane-tree';

export interface HubState {
  paneTree: PaneNode;
  focusedPaneId: string;
  dragSourcePaneId: string | null;
  dragOverPaneId: string | null;
  loaded: boolean;
  zoomedPaneId: string | null;

  loadHub: (storage: ScopedStorage, prefix: string) => Promise<void>;
  saveHub: (storage: ScopedStorage) => Promise<void>;
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical', prefix: string, position?: 'before' | 'after') => void;
  closePane: (paneId: string, prefix: string) => void;
  assignAgent: (paneId: string, agentId: string | null, projectId?: string) => void;
  setFocusedPane: (paneId: string) => void;
  removePanesByAgent: (agentId: string) => void;
  swapPanes: (id1: string, id2: string) => void;
  setDragSource: (paneId: string | null) => void;
  setDragOver: (paneId: string | null) => void;
  validateAgents: (knownIds: Set<string>) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  toggleZoom: (paneId: string) => void;
}

const STORAGE_KEY = 'hub-pane-tree';

export function createHubStore(panePrefix: string): UseBoundStore<StoreApi<HubState>> {
  const initialLeaf = createLeaf(panePrefix);

  return create<HubState>((set, get) => ({
    paneTree: initialLeaf,
    focusedPaneId: initialLeaf.id,
    dragSourcePaneId: null,
    dragOverPaneId: null,
    loaded: false,
    zoomedPaneId: null,

    loadHub: async (storage, prefix) => {
      try {
        const saved = await storage.read(STORAGE_KEY) as PaneNode | null;
        if (saved && (saved.type === 'leaf' || saved.type === 'split')) {
          syncCounterToTree(saved);
          set({ paneTree: saved, focusedPaneId: getFirstLeafId(saved), loaded: true });
        } else {
          const leaf = createLeaf(prefix);
          set({ paneTree: leaf, focusedPaneId: leaf.id, loaded: true });
        }
      } catch {
        const leaf = createLeaf(prefix);
        set({ paneTree: leaf, focusedPaneId: leaf.id, loaded: true });
      }
    },

    saveHub: async (storage) => {
      await storage.write(STORAGE_KEY, get().paneTree);
    },

    splitPane: (paneId, direction, prefix, position) => {
      const newTree = splitPaneOp(get().paneTree, paneId, direction, prefix, position);
      set({ paneTree: newTree });
    },

    closePane: (paneId, prefix) => {
      const result = closePaneOp(get().paneTree, paneId);
      const clearZoom = get().zoomedPaneId === paneId ? null : get().zoomedPaneId;
      if (result === null) {
        const leaf = createLeaf(prefix);
        set({ paneTree: leaf, focusedPaneId: leaf.id, zoomedPaneId: null });
      } else {
        const focused = get().focusedPaneId === paneId ? getFirstLeafId(result) : get().focusedPaneId;
        // Also clear zoom if zoomed pane no longer exists in the tree
        const zoomedStillExists = clearZoom ? findLeaf(result, clearZoom) !== null : false;
        set({ paneTree: result, focusedPaneId: focused, zoomedPaneId: zoomedStillExists ? clearZoom : null });
      }
    },

    assignAgent: (paneId, agentId, projectId) => {
      set({ paneTree: assignAgentOp(get().paneTree, paneId, agentId, projectId) });
    },

    setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

    removePanesByAgent: (agentId) => {
      set({ paneTree: removePanesByAgentOp(get().paneTree, agentId) });
    },

    swapPanes: (id1, id2) => {
      set({ paneTree: swapPanesOp(get().paneTree, id1, id2) });
    },

    setDragSource: (paneId) => set({ dragSourcePaneId: paneId }),
    setDragOver: (paneId) => set({ dragOverPaneId: paneId }),

    validateAgents: (knownIds) => {
      set({ paneTree: validateAgentsOp(get().paneTree, knownIds) });
    },

    setSplitRatio: (splitId, ratio) => {
      set({ paneTree: setSplitRatioOp(get().paneTree, splitId, ratio) });
    },

    toggleZoom: (paneId) => {
      const current = get().zoomedPaneId;
      set({ zoomedPaneId: current === paneId ? null : paneId });
    },
  }));
}
