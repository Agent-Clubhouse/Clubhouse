import { create } from 'zustand';

export type PaneNode =
  | { id: string; type: 'leaf'; agentId: string | null }
  | { id: string; type: 'split'; direction: 'horizontal' | 'vertical'; children: [PaneNode, PaneNode] };

let paneCounter = 0;
function generatePaneId(): string {
  return `pane_${paneCounter++}`;
}

function storageKey(projectId: string): string {
  return `hub_layout_${projectId}`;
}

function saveToStorage(projectId: string | null, tree: PaneNode | null): void {
  if (!projectId || !tree) return;
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(tree));
  } catch {
    // Ignore quota errors
  }
}

function loadFromStorage(projectId: string): PaneNode | null {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw) as PaneNode;
  } catch {
    return null;
  }
}

/** Null out agentIds that aren't in the known set, so those panes revert to the picker. */
function validateAgents(node: PaneNode, knownAgentIds: Set<string>): PaneNode {
  if (node.type === 'leaf') {
    if (node.agentId && !knownAgentIds.has(node.agentId)) {
      return { ...node, agentId: null };
    }
    return node;
  }
  return {
    ...node,
    children: [
      validateAgents(node.children[0], knownAgentIds),
      validateAgents(node.children[1], knownAgentIds),
    ],
  };
}

/** Find the max pane counter in a tree so new IDs don't collide with restored ones. */
function maxPaneCounter(node: PaneNode): number {
  const match = node.id.match(/^pane_(\d+)$/);
  const current = match ? parseInt(match[1], 10) : -1;
  if (node.type === 'leaf') return current;
  return Math.max(current, maxPaneCounter(node.children[0]), maxPaneCounter(node.children[1]));
}

interface HubState {
  paneTree: PaneNode | null;
  focusedPaneId: string | null;
  activeProjectId: string | null;
  loadHub: (projectId: string, knownAgentIds: Set<string>) => void;
  splitPane: (paneId: string, direction: 'up' | 'down' | 'left' | 'right') => void;
  closePane: (paneId: string) => void;
  assignAgent: (paneId: string, agentId: string) => void;
  setFocusedPane: (paneId: string | null) => void;
  removePanesByAgent: (agentId: string) => void;
}

function findAndReplace(node: PaneNode, targetId: string, replacement: PaneNode): PaneNode | null {
  if (node.id === targetId) return replacement;
  if (node.type === 'split') {
    const left = findAndReplace(node.children[0], targetId, replacement);
    if (left) return { ...node, children: [left, node.children[1]] };
    const right = findAndReplace(node.children[1], targetId, replacement);
    if (right) return { ...node, children: [node.children[0], right] };
  }
  return null;
}

function findParentAndSibling(
  node: PaneNode,
  targetId: string,
  parent: PaneNode | null = null,
  siblingIndex: 0 | 1 | null = null,
): { parent: PaneNode; sibling: PaneNode } | null {
  if (node.id === targetId && parent && parent.type === 'split' && siblingIndex !== null) {
    const sibling = parent.children[siblingIndex === 0 ? 1 : 0];
    return { parent, sibling };
  }
  if (node.type === 'split') {
    const left = findParentAndSibling(node.children[0], targetId, node, 0);
    if (left) return left;
    const right = findParentAndSibling(node.children[1], targetId, node, 1);
    if (right) return right;
  }
  return null;
}

function mapLeaves(node: PaneNode, fn: (leaf: PaneNode & { type: 'leaf' }) => PaneNode): PaneNode {
  if (node.type === 'leaf') return fn(node);
  return {
    ...node,
    children: [mapLeaves(node.children[0], fn), mapLeaves(node.children[1], fn)],
  };
}

export const useHubStore = create<HubState>((set, get) => ({
  paneTree: null,
  focusedPaneId: null,
  activeProjectId: null,

  loadHub: (projectId, knownAgentIds) => {
    const current = get();
    // If already loaded for this project, just validate agents
    if (current.activeProjectId === projectId && current.paneTree) {
      const validated = validateAgents(current.paneTree, knownAgentIds);
      if (validated !== current.paneTree) {
        set({ paneTree: validated });
        saveToStorage(projectId, validated);
      }
      return;
    }

    // Try to restore from localStorage
    const saved = loadFromStorage(projectId);
    if (saved) {
      // Sync counter so new IDs don't collide
      const max = maxPaneCounter(saved);
      if (max >= paneCounter) paneCounter = max + 1;

      const validated = validateAgents(saved, knownAgentIds);
      const focus = getFirstLeafId(validated);
      set({ paneTree: validated, focusedPaneId: focus, activeProjectId: projectId });
      saveToStorage(projectId, validated);
      return;
    }

    // No saved state — create a fresh single pane
    const id = generatePaneId();
    const tree: PaneNode = { id, type: 'leaf', agentId: null };
    set({ paneTree: tree, focusedPaneId: id, activeProjectId: projectId });
  },

  splitPane: (paneId, direction) => {
    const tree = get().paneTree;
    if (!tree) return;

    const newPaneId = generatePaneId();
    const splitId = generatePaneId();
    const newLeaf: PaneNode = { id: newPaneId, type: 'leaf', agentId: null };

    const isHorizontal = direction === 'left' || direction === 'right';
    const splitDirection: 'horizontal' | 'vertical' = isHorizontal ? 'horizontal' : 'vertical';
    const newFirst = direction === 'left' || direction === 'up';

    const existingLeaf = findLeaf(tree, paneId);
    if (!existingLeaf) return;

    const replacement: PaneNode = {
      id: splitId,
      type: 'split',
      direction: splitDirection,
      children: newFirst
        ? [newLeaf, { ...existingLeaf }]
        : [{ ...existingLeaf }, newLeaf],
    };

    const newTree = findAndReplace(tree, paneId, replacement);
    if (newTree) {
      set({ paneTree: newTree, focusedPaneId: newPaneId });
      saveToStorage(get().activeProjectId, newTree);
    }
  },

  closePane: (paneId) => {
    const tree = get().paneTree;
    if (!tree) return;

    // If the tree is just this single leaf, reset to a fresh empty pane
    if (tree.type === 'leaf' && tree.id === paneId) {
      const id = generatePaneId();
      const newTree: PaneNode = { id, type: 'leaf', agentId: null };
      set({ paneTree: newTree, focusedPaneId: id });
      saveToStorage(get().activeProjectId, newTree);
      return;
    }

    // Find parent split and surviving sibling
    const result = findParentAndSibling(tree, paneId);
    if (!result) return;

    const { parent, sibling } = result;
    const newTree = findAndReplace(tree, parent.id, sibling);
    if (newTree) {
      const newFocus = getFirstLeafId(sibling);
      set({ paneTree: newTree, focusedPaneId: newFocus });
      saveToStorage(get().activeProjectId, newTree);
    }
  },

  assignAgent: (paneId, agentId) => {
    const tree = get().paneTree;
    if (!tree) return;
    const newTree = mapLeaves(tree, (leaf) => {
      if (leaf.id === paneId) return { ...leaf, agentId };
      return leaf;
    });
    set({ paneTree: newTree, focusedPaneId: paneId });
    saveToStorage(get().activeProjectId, newTree);
  },

  setFocusedPane: (paneId) => set({ focusedPaneId: paneId }),

  removePanesByAgent: (agentId) => {
    const tree = get().paneTree;
    if (!tree) return;
    const newTree = mapLeaves(tree, (leaf) => {
      if (leaf.agentId === agentId) return { ...leaf, agentId: null };
      return leaf;
    });
    set({ paneTree: newTree });
    saveToStorage(get().activeProjectId, newTree);
  },
}));

function findLeaf(node: PaneNode, id: string): (PaneNode & { type: 'leaf' }) | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeaf(node.children[0], id) || findLeaf(node.children[1], id);
}

function getFirstLeafId(node: PaneNode): string {
  if (node.type === 'leaf') return node.id;
  return getFirstLeafId(node.children[0]);
}
