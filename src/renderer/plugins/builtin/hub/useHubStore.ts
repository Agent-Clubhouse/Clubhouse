import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateHubName } from '../../../../shared/name-generator';
import {
  PaneNode,
  createLeaf,
  splitPane as splitPaneOp,
  closePane as closePaneOp,
  assignAgent as assignAgentOp,
  swapPanes as swapPanesOp,
  removePanesByAgent as removePanesByAgentOp,
  validateAgents as validateAgentsOp,
  sanitizeProjectIds as sanitizeProjectIdsOp,
  setSplitRatio as setSplitRatioOp,
  getFirstLeafId,
  findLeaf,
  syncCounterToTree,
  createPaneCounter,
  type PaneCounter,
} from './pane-tree';

// ── Hub instance — one per tab ───────────────────────────────────────

export interface HubInstance {
  id: string;
  name: string;
  paneTree: PaneNode;
  focusedPaneId: string;
  zoomedPaneId: string | null;
}

/** Serialisable snapshot persisted to storage */
export interface HubInstanceData {
  id: string;
  name: string;
  paneTree: PaneNode;
}

// ── Store state ──────────────────────────────────────────────────────

export interface HubState {
  hubs: HubInstance[];
  activeHubId: string;
  dragSourcePaneId: string | null;
  dragOverPaneId: string | null;
  loaded: boolean;

  // Lifecycle
  loadHub: (storage: ScopedStorage, prefix: string, currentProjectId?: string) => Promise<void>;
  saveHub: (storage: ScopedStorage) => Promise<void>;

  // Hub management
  addHub: (prefix: string) => string;
  removeHub: (hubId: string, prefix: string) => void;
  renameHub: (hubId: string, name: string) => void;
  setActiveHub: (hubId: string) => void;

  // Pane operations (scoped to active hub)
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

  // Convenience selectors
  activeHub: () => HubInstance;
  /** @deprecated — use activeHub().paneTree */
  paneTree: PaneNode;
  /** @deprecated — use activeHub().focusedPaneId */
  focusedPaneId: string;
  /** @deprecated — use activeHub().zoomedPaneId */
  zoomedPaneId: string | null;
}

// ── Storage keys ─────────────────────────────────────────────────────

const STORAGE_KEY_INSTANCES = 'hub-instances';
const STORAGE_KEY_ACTIVE = 'hub-active-id';
const LEGACY_STORAGE_KEY = 'hub-pane-tree';

// ── Helpers ──────────────────────────────────────────────────────────

/** Default module-level hub counter (backward compat for tests). */
const defaultHubCounter = { value: 0 };

export function generateHubId(counter = defaultHubCounter): string {
  return `hub_inst_${++counter.value}`;
}

export function resetHubIdCounter(value = 0, counter = defaultHubCounter): void {
  counter.value = value;
}

function createHubInstance(prefix: string, paneCounter: PaneCounter, hubCounter: { value: number }): HubInstance {
  const leaf = createLeaf(prefix, null, undefined, paneCounter);
  return {
    id: generateHubId(hubCounter),
    name: generateHubName(),
    paneTree: leaf,
    focusedPaneId: leaf.id,
    zoomedPaneId: null,
  };
}

function updateActiveHub(state: HubState, updater: (hub: HubInstance) => Partial<HubInstance>): Partial<HubState> {
  const hubs = state.hubs.map((h) => {
    if (h.id !== state.activeHubId) return h;
    return { ...h, ...updater(h) };
  });
  const active = hubs.find((h) => h.id === state.activeHubId)!;
  return {
    hubs,
    paneTree: active.paneTree,
    focusedPaneId: active.focusedPaneId,
    zoomedPaneId: active.zoomedPaneId,
  };
}

function syncDerivedState(hubs: HubInstance[], activeHubId: string): Pick<HubState, 'paneTree' | 'focusedPaneId' | 'zoomedPaneId'> {
  const active = hubs.find((h) => h.id === activeHubId) ?? hubs[0];
  return {
    paneTree: active.paneTree,
    focusedPaneId: active.focusedPaneId,
    zoomedPaneId: active.zoomedPaneId,
  };
}

// ── Store factory ────────────────────────────────────────────────────

export function createHubStore(panePrefix: string): UseBoundStore<StoreApi<HubState>> {
  // Per-store-instance counters to prevent ID collisions between stores
  const paneCounter = createPaneCounter();
  const hubCounter = { value: 0 };
  const initialHub = createHubInstance(panePrefix, paneCounter, hubCounter);

  return create<HubState>((set, get) => ({
    hubs: [initialHub],
    activeHubId: initialHub.id,
    paneTree: initialHub.paneTree,
    focusedPaneId: initialHub.focusedPaneId,
    zoomedPaneId: null,
    dragSourcePaneId: null,
    dragOverPaneId: null,
    loaded: false,

    activeHub: () => {
      const state = get();
      return state.hubs.find((h) => h.id === state.activeHubId) ?? state.hubs[0];
    },

    // ── Lifecycle ──────────────────────────────────────────────────

    loadHub: async (storage, prefix, currentProjectId) => {
      /** Sanitize cross-project references when loading in project context. */
      const sanitize = (tree: PaneNode): PaneNode =>
        currentProjectId ? sanitizeProjectIdsOp(tree, currentProjectId) : tree;

      try {
        // Try new multi-hub format first
        const savedInstances = await storage.read(STORAGE_KEY_INSTANCES) as HubInstanceData[] | null;
        if (savedInstances && Array.isArray(savedInstances) && savedInstances.length > 0) {
          const hubs: HubInstance[] = savedInstances.map((s): HubInstance => {
            const tree = sanitize(s.paneTree);
            syncCounterToTree(tree, paneCounter);
            return {
              id: s.id,
              name: s.name,
              paneTree: tree,
              focusedPaneId: getFirstLeafId(tree),
              zoomedPaneId: null,
            };
          });
          // Sync hub ID counter
          const maxSuffix = hubs.reduce((max, h) => {
            const m = h.id.match(/_(\d+)$/);
            return m ? Math.max(max, parseInt(m[1], 10)) : max;
          }, 0);
          if (maxSuffix >= hubCounter.value) hubCounter.value = maxSuffix;

          const savedActive = await storage.read(STORAGE_KEY_ACTIVE) as string | null;
          const activeHubId = (savedActive && hubs.find((h) => h.id === savedActive))
            ? savedActive
            : hubs[0].id;

          set({ hubs, activeHubId, loaded: true, ...syncDerivedState(hubs, activeHubId) });
          return;
        }

        // Migrate from legacy single-tree format
        const legacyTree = await storage.read(LEGACY_STORAGE_KEY) as PaneNode | null;
        if (legacyTree && (legacyTree.type === 'leaf' || legacyTree.type === 'split')) {
          const tree = sanitize(legacyTree);
          syncCounterToTree(tree, paneCounter);
          const hub: HubInstance = {
            id: generateHubId(hubCounter),
            name: generateHubName(),
            paneTree: tree,
            focusedPaneId: getFirstLeafId(tree),
            zoomedPaneId: null,
          };
          set({ hubs: [hub], activeHubId: hub.id, loaded: true, ...syncDerivedState([hub], hub.id) });
          return;
        }

        // Fresh start
        const hub = createHubInstance(prefix, paneCounter, hubCounter);
        set({ hubs: [hub], activeHubId: hub.id, loaded: true, ...syncDerivedState([hub], hub.id) });
      } catch {
        const hub = createHubInstance(prefix, paneCounter, hubCounter);
        set({ hubs: [hub], activeHubId: hub.id, loaded: true, ...syncDerivedState([hub], hub.id) });
      }
    },

    saveHub: async (storage) => {
      const { hubs, activeHubId } = get();
      const data: HubInstanceData[] = hubs.map((h) => ({
        id: h.id,
        name: h.name,
        paneTree: h.paneTree,
      }));
      await storage.write(STORAGE_KEY_INSTANCES, data);
      await storage.write(STORAGE_KEY_ACTIVE, activeHubId);
    },

    // ── Hub management ─────────────────────────────────────────────

    addHub: (prefix) => {
      const hub = createHubInstance(prefix, paneCounter, hubCounter);
      const hubs = [...get().hubs, hub];
      set({ hubs, activeHubId: hub.id, ...syncDerivedState(hubs, hub.id) });
      return hub.id;
    },

    removeHub: (hubId, prefix) => {
      const { hubs, activeHubId } = get();
      if (hubs.length <= 1) {
        // Can't remove the last hub — reset it instead
        const fresh = createHubInstance(prefix, paneCounter, hubCounter);
        set({ hubs: [fresh], activeHubId: fresh.id, ...syncDerivedState([fresh], fresh.id) });
        return;
      }
      const filtered = hubs.filter((h) => h.id !== hubId);
      const newActive = activeHubId === hubId ? filtered[0].id : activeHubId;
      set({ hubs: filtered, activeHubId: newActive, ...syncDerivedState(filtered, newActive) });
    },

    renameHub: (hubId, name) => {
      const hubs = get().hubs.map((h) => h.id === hubId ? { ...h, name } : h);
      set({ hubs });
    },

    setActiveHub: (hubId) => {
      const { hubs } = get();
      if (hubs.find((h) => h.id === hubId)) {
        set({ activeHubId: hubId, ...syncDerivedState(hubs, hubId) });
      }
    },

    // ── Pane operations (active hub) ───────────────────────────────

    splitPane: (paneId, direction, prefix, position) => {
      set(updateActiveHub(get(), (hub) => ({
        paneTree: splitPaneOp(hub.paneTree, paneId, direction, prefix, position, paneCounter),
      })));
    },

    closePane: (paneId, prefix) => {
      set(updateActiveHub(get(), (hub) => {
        const result = closePaneOp(hub.paneTree, paneId);
        const clearZoom = hub.zoomedPaneId === paneId ? null : hub.zoomedPaneId;
        if (result === null) {
          const leaf = createLeaf(prefix, null, undefined, paneCounter);
          return { paneTree: leaf, focusedPaneId: leaf.id, zoomedPaneId: null };
        }
        const focused = hub.focusedPaneId === paneId ? getFirstLeafId(result) : hub.focusedPaneId;
        const zoomedStillExists = clearZoom ? findLeaf(result, clearZoom) !== null : false;
        return { paneTree: result, focusedPaneId: focused, zoomedPaneId: zoomedStillExists ? clearZoom : null };
      }));
    },

    assignAgent: (paneId, agentId, projectId) => {
      set(updateActiveHub(get(), (hub) => ({
        paneTree: assignAgentOp(hub.paneTree, paneId, agentId, projectId),
      })));
    },

    setFocusedPane: (paneId) => {
      set(updateActiveHub(get(), () => ({ focusedPaneId: paneId })));
    },

    removePanesByAgent: (agentId) => {
      // Remove from ALL hubs, not just active
      const hubs = get().hubs.map((h) => ({
        ...h,
        paneTree: removePanesByAgentOp(h.paneTree, agentId),
      }));
      const active = hubs.find((h) => h.id === get().activeHubId) ?? hubs[0];
      set({ hubs, paneTree: active.paneTree, focusedPaneId: active.focusedPaneId, zoomedPaneId: active.zoomedPaneId });
    },

    swapPanes: (id1, id2) => {
      set(updateActiveHub(get(), (hub) => ({
        paneTree: swapPanesOp(hub.paneTree, id1, id2),
      })));
    },

    setDragSource: (paneId) => set({ dragSourcePaneId: paneId }),
    setDragOver: (paneId) => set({ dragOverPaneId: paneId }),

    validateAgents: (knownIds) => {
      // Validate across ALL hubs
      const hubs = get().hubs.map((h) => ({
        ...h,
        paneTree: validateAgentsOp(h.paneTree, knownIds),
      }));
      const active = hubs.find((h) => h.id === get().activeHubId) ?? hubs[0];
      set({ hubs, paneTree: active.paneTree, focusedPaneId: active.focusedPaneId, zoomedPaneId: active.zoomedPaneId });
    },

    setSplitRatio: (splitId, ratio) => {
      set(updateActiveHub(get(), (hub) => ({
        paneTree: setSplitRatioOp(hub.paneTree, splitId, ratio),
      })));
    },

    toggleZoom: (paneId) => {
      set(updateActiveHub(get(), (hub) => ({
        zoomedPaneId: hub.zoomedPaneId === paneId ? null : paneId,
      })));
    },
  }));
}
