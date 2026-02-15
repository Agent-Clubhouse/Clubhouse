// ── Pane tree data model & pure operations ───────────────────────────

export interface LeafPane {
  type: 'leaf';
  id: string;
  agentId: string | null;
  projectId?: string;
}

export interface SplitPane {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  children: [PaneNode, PaneNode];
}

export type PaneNode = LeafPane | SplitPane;

let paneCounter = 0;

export function generatePaneId(prefix: string): string {
  return `${prefix}_${++paneCounter}`;
}

export function resetPaneCounter(value = 0): void {
  paneCounter = value;
}

export function createLeaf(prefix: string, agentId: string | null = null, projectId?: string): LeafPane {
  return { type: 'leaf', id: generatePaneId(prefix), agentId, projectId };
}

export function splitPane(
  tree: PaneNode,
  paneId: string,
  direction: 'horizontal' | 'vertical',
  prefix: string,
  position: 'before' | 'after' = 'after',
): PaneNode {
  if (tree.type === 'leaf') {
    if (tree.id === paneId) {
      const newLeaf = createLeaf(prefix);
      return {
        type: 'split',
        id: generatePaneId(prefix),
        direction,
        children: position === 'before'
          ? [newLeaf, tree]
          : [tree, newLeaf],
      };
    }
    return tree;
  }
  return {
    ...tree,
    children: [
      splitPane(tree.children[0], paneId, direction, prefix, position),
      splitPane(tree.children[1], paneId, direction, prefix, position),
    ] as [PaneNode, PaneNode],
  };
}

export function closePane(tree: PaneNode, paneId: string): PaneNode | null {
  if (tree.type === 'leaf') {
    return tree.id === paneId ? null : tree;
  }

  const [left, right] = tree.children;

  if (left.type === 'leaf' && left.id === paneId) return right;
  if (right.type === 'leaf' && right.id === paneId) return left;

  const newLeft = closePane(left, paneId);
  const newRight = closePane(right, paneId);

  if (newLeft === null) return newRight;
  if (newRight === null) return newLeft;
  if (newLeft === left && newRight === right) return tree;

  return { ...tree, children: [newLeft, newRight] as [PaneNode, PaneNode] };
}

export function swapPanes(tree: PaneNode, id1: string, id2: string): PaneNode {
  const leaf1 = findLeaf(tree, id1);
  const leaf2 = findLeaf(tree, id2);
  if (!leaf1 || !leaf2) return tree;

  const swap1 = { agentId: leaf1.agentId, projectId: leaf1.projectId };
  const swap2 = { agentId: leaf2.agentId, projectId: leaf2.projectId };

  let result = assignAgent(tree, id1, swap2.agentId, swap2.projectId);
  result = assignAgent(result, id2, swap1.agentId, swap1.projectId);
  return result;
}

export function assignAgent(tree: PaneNode, paneId: string, agentId: string | null, projectId?: string): PaneNode {
  if (tree.type === 'leaf') {
    if (tree.id === paneId) {
      return { ...tree, agentId, projectId };
    }
    return tree;
  }
  return {
    ...tree,
    children: [
      assignAgent(tree.children[0], paneId, agentId, projectId),
      assignAgent(tree.children[1], paneId, agentId, projectId),
    ] as [PaneNode, PaneNode],
  };
}

export function removePanesByAgent(tree: PaneNode, agentId: string): PaneNode {
  return mapLeaves(tree, (leaf) =>
    leaf.agentId === agentId ? { ...leaf, agentId: null, projectId: undefined } : leaf
  );
}

export function validateAgents(tree: PaneNode, knownIds: Set<string>): PaneNode {
  return mapLeaves(tree, (leaf) =>
    leaf.agentId && !knownIds.has(leaf.agentId)
      ? { ...leaf, agentId: null, projectId: undefined }
      : leaf
  );
}

export function findLeaf(tree: PaneNode, paneId: string): LeafPane | null {
  if (tree.type === 'leaf') {
    return tree.id === paneId ? tree : null;
  }
  return findLeaf(tree.children[0], paneId) || findLeaf(tree.children[1], paneId);
}

export function getFirstLeafId(tree: PaneNode): string {
  if (tree.type === 'leaf') return tree.id;
  return getFirstLeafId(tree.children[0]);
}

export function mapLeaves(tree: PaneNode, fn: (leaf: LeafPane) => LeafPane): PaneNode {
  if (tree.type === 'leaf') return fn(tree);
  return {
    ...tree,
    children: [
      mapLeaves(tree.children[0], fn),
      mapLeaves(tree.children[1], fn),
    ] as [PaneNode, PaneNode],
  };
}

export function collectLeaves(tree: PaneNode): LeafPane[] {
  if (tree.type === 'leaf') return [tree];
  return [...collectLeaves(tree.children[0]), ...collectLeaves(tree.children[1])];
}

/** Extract the max numeric suffix from all node IDs in the tree */
function maxIdSuffix(tree: PaneNode): number {
  const match = tree.id.match(/_(\d+)$/);
  const val = match ? parseInt(match[1], 10) : 0;
  if (tree.type === 'leaf') return val;
  return Math.max(val, maxIdSuffix(tree.children[0]), maxIdSuffix(tree.children[1]));
}

/** Ensure paneCounter is above any existing ID in the tree to prevent collisions */
export function syncCounterToTree(tree: PaneNode): void {
  const max = maxIdSuffix(tree);
  if (max >= paneCounter) {
    paneCounter = max;
  }
}
