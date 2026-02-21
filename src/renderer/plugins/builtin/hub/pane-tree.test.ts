import { describe, it, expect, beforeEach } from 'vitest';
import {
  generatePaneId,
  resetPaneCounter,
  createLeaf,
  splitPane,
  closePane,
  assignAgent,
  swapPanes,
  removePanesByAgent,
  validateAgents,
  findLeaf,
  findSplit,
  getFirstLeafId,
  mapLeaves,
  collectLeaves,
  syncCounterToTree,
  setSplitRatio,
  type PaneNode,
  type LeafPane,
  type SplitPane,
} from './pane-tree';

describe('pane-tree', () => {
  beforeEach(() => {
    resetPaneCounter(0);
  });

  // ── generatePaneId / resetPaneCounter ─────────────────────────────────

  describe('generatePaneId', () => {
    it('generates sequential IDs', () => {
      expect(generatePaneId('p')).toBe('p_1');
      expect(generatePaneId('p')).toBe('p_2');
      expect(generatePaneId('p')).toBe('p_3');
    });

    it('uses the given prefix', () => {
      expect(generatePaneId('hub')).toBe('hub_1');
      expect(generatePaneId('test')).toBe('test_2');
    });
  });

  describe('resetPaneCounter', () => {
    it('resets to 0 by default', () => {
      generatePaneId('p'); // p_1
      resetPaneCounter();
      expect(generatePaneId('p')).toBe('p_1');
    });

    it('resets to custom value', () => {
      resetPaneCounter(10);
      expect(generatePaneId('p')).toBe('p_11');
    });
  });

  // ── createLeaf ────────────────────────────────────────────────────────

  describe('createLeaf', () => {
    it('creates a leaf with defaults', () => {
      const leaf = createLeaf('hub');
      expect(leaf.type).toBe('leaf');
      expect(leaf.agentId).toBeNull();
      expect(leaf.projectId).toBeUndefined();
    });

    it('creates a leaf with an agent', () => {
      const leaf = createLeaf('hub', 'agent-1');
      expect(leaf.agentId).toBe('agent-1');
    });

    it('creates a leaf with a project', () => {
      const leaf = createLeaf('hub', 'agent-1', 'proj-1');
      expect(leaf.agentId).toBe('agent-1');
      expect(leaf.projectId).toBe('proj-1');
    });

    it('generates unique IDs', () => {
      const a = createLeaf('hub');
      const b = createLeaf('hub');
      expect(a.id).not.toBe(b.id);
    });

    it('includes prefix in ID', () => {
      const leaf = createLeaf('test');
      expect(leaf.id).toMatch(/^test_/);
    });
  });

  // ── splitPane ─────────────────────────────────────────────────────────

  describe('splitPane', () => {
    it('splits a single leaf (default after)', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p');
      expect(result.type).toBe('split');
      const split = result as SplitPane;
      expect(split.direction).toBe('horizontal');
      expect(split.children[0]).toBe(leaf);
      expect(split.children[1].type).toBe('leaf');
    });

    it('splits with before position', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'vertical', 'p', 'before') as SplitPane;
      expect(result.children[0].type).toBe('leaf');
      expect(result.children[0]).not.toBe(leaf);
      expect(result.children[1]).toBe(leaf);
    });

    it('splits with after position', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'vertical', 'p', 'after') as SplitPane;
      expect(result.children[0]).toBe(leaf);
      expect(result.children[1].type).toBe('leaf');
      expect(result.children[1]).not.toBe(leaf);
    });

    it('supports horizontal direction', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      expect(result.direction).toBe('horizontal');
    });

    it('supports vertical direction', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'vertical', 'p') as SplitPane;
      expect(result.direction).toBe('vertical');
    });

    it('returns same ref when paneId not found', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, 'nonexistent', 'horizontal', 'p');
      expect(result).toBe(leaf);
    });

    it('new leaf has null agent', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      const newLeaf = result.children[1] as LeafPane;
      expect(newLeaf.agentId).toBeNull();
    });

    it('splits nested left child', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = splitPane(tree, leaf1.id, 'vertical', 'p') as SplitPane;
      expect(result.children[0].type).toBe('split');
      expect(result.children[1]).toBe(leaf2);
    });

    it('splits nested right child', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = splitPane(tree, leaf2.id, 'vertical', 'p') as SplitPane;
      expect(result.children[0]).toBe(leaf1);
      expect(result.children[1].type).toBe('split');
    });

    it('splits deeply nested pane', () => {
      const leaf = createLeaf('p');
      let tree: PaneNode = leaf;
      tree = splitPane(tree, leaf.id, 'horizontal', 'p');
      // Now split the original leaf again (it's children[0])
      tree = splitPane(tree, leaf.id, 'vertical', 'p');
      const leaves = collectLeaves(tree);
      expect(leaves).toHaveLength(3);
    });
  });

  // ── closePane ─────────────────────────────────────────────────────────

  describe('closePane', () => {
    it('returns null when closing the only leaf', () => {
      const leaf = createLeaf('p');
      expect(closePane(leaf, leaf.id)).toBeNull();
    });

    it('returns sibling when closing left child', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = closePane(tree, leaf1.id);
      expect(result).toBe(leaf2);
    });

    it('returns sibling when closing right child', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = closePane(tree, leaf2.id);
      expect(result).toBe(leaf1);
    });

    it('returns unchanged tree when paneId not found', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = closePane(tree, 'nonexistent');
      expect(result).toBe(tree);
    });

    it('propagates through nested splits', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 'split_inner', direction: 'vertical',
        children: [leaf2, leaf3],
      };
      const outer: SplitPane = {
        type: 'split', id: 'split_outer', direction: 'horizontal',
        children: [leaf1, inner],
      };
      const result = closePane(outer, leaf2.id) as SplitPane;
      expect(result.type).toBe('split');
      expect(result.children[0]).toBe(leaf1);
      expect(result.children[1]).toBe(leaf3);
    });

    it('promotes sibling when parent is removed', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 'split_1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(closePane(tree, leaf1.id)).toBe(leaf2);
    });

    it('preserves structural sharing when not-found', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(closePane(tree, 'nope')).toBe(tree);
    });
  });

  // ── assignAgent ─────────────────────────────────────────────────────

  describe('assignAgent', () => {
    it('sets agent on a leaf', () => {
      const leaf = createLeaf('p');
      const result = assignAgent(leaf, leaf.id, 'agent-1') as LeafPane;
      expect(result.agentId).toBe('agent-1');
    });

    it('unsets agent (null)', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = assignAgent(leaf, leaf.id, null) as LeafPane;
      expect(result.agentId).toBeNull();
    });

    it('sets agent with projectId', () => {
      const leaf = createLeaf('p');
      const result = assignAgent(leaf, leaf.id, 'agent-1', 'proj-1') as LeafPane;
      expect(result.agentId).toBe('agent-1');
      expect(result.projectId).toBe('proj-1');
    });

    it('targets nested leaf', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = assignAgent(tree, leaf2.id, 'agent-2') as SplitPane;
      expect((result.children[1] as LeafPane).agentId).toBe('agent-2');
      expect(result.children[0]).toBe(leaf1); // unchanged
    });

    it('returns same ref when paneId not found', () => {
      const leaf = createLeaf('p');
      const result = assignAgent(leaf, 'nonexistent', 'agent-1');
      expect(result).toBe(leaf);
    });

    it('preserves structural sharing for unchanged branches', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = assignAgent(tree, leaf2.id, 'agent-1') as SplitPane;
      expect(result.children[0]).toBe(leaf1);
    });
  });

  // ── swapPanes ─────────────────────────────────────────────────────────

  describe('swapPanes', () => {
    it('swaps agents between two panes', () => {
      const leaf1 = createLeaf('p', 'agent-1', 'proj-1');
      const leaf2 = createLeaf('p', 'agent-2', 'proj-2');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = swapPanes(tree, leaf1.id, leaf2.id) as SplitPane;
      const r1 = result.children[0] as LeafPane;
      const r2 = result.children[1] as LeafPane;
      expect(r1.agentId).toBe('agent-2');
      expect(r1.projectId).toBe('proj-2');
      expect(r2.agentId).toBe('agent-1');
      expect(r2.projectId).toBe('proj-1');
    });

    it('returns same ref when id1 not found', () => {
      const leaf = createLeaf('p');
      const result = swapPanes(leaf, 'nope', leaf.id);
      expect(result).toBe(leaf);
    });

    it('returns same ref when id2 not found', () => {
      const leaf = createLeaf('p');
      const result = swapPanes(leaf, leaf.id, 'nope');
      expect(result).toBe(leaf);
    });

    it('self-swap produces no change', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = swapPanes(leaf, leaf.id, leaf.id) as LeafPane;
      expect(result.agentId).toBe('agent-1');
    });

    it('swaps null and non-null agents', () => {
      const leaf1 = createLeaf('p', null);
      const leaf2 = createLeaf('p', 'agent-1');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = swapPanes(tree, leaf1.id, leaf2.id) as SplitPane;
      expect((result.children[0] as LeafPane).agentId).toBe('agent-1');
      expect((result.children[1] as LeafPane).agentId).toBeNull();
    });
  });

  // ── removePanesByAgent ────────────────────────────────────────────────

  describe('removePanesByAgent', () => {
    it('clears matching agent', () => {
      const leaf = createLeaf('p', 'agent-1', 'proj-1');
      const result = removePanesByAgent(leaf, 'agent-1') as LeafPane;
      expect(result.agentId).toBeNull();
      expect(result.projectId).toBeUndefined();
    });

    it('keeps non-matching agent', () => {
      const leaf = createLeaf('p', 'agent-2');
      const result = removePanesByAgent(leaf, 'agent-1');
      expect(result).toBe(leaf);
    });

    it('no-op when agent not found', () => {
      const leaf = createLeaf('p', null);
      const result = removePanesByAgent(leaf, 'agent-1');
      expect(result).toBe(leaf);
    });

    it('clears multiple matching leaves in tree', () => {
      const leaf1 = createLeaf('p', 'agent-1');
      const leaf2 = createLeaf('p', 'agent-1');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = removePanesByAgent(tree, 'agent-1') as SplitPane;
      expect((result.children[0] as LeafPane).agentId).toBeNull();
      expect((result.children[1] as LeafPane).agentId).toBeNull();
    });
  });

  // ── validateAgents ────────────────────────────────────────────────────

  describe('validateAgents', () => {
    it('clears unknown agent', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = validateAgents(leaf, new Set(['agent-2'])) as LeafPane;
      expect(result.agentId).toBeNull();
      expect(result.projectId).toBeUndefined();
    });

    it('preserves known agent', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = validateAgents(leaf, new Set(['agent-1']));
      expect(result).toBe(leaf);
    });

    it('empty set clears all agents', () => {
      const leaf = createLeaf('p', 'agent-1');
      const result = validateAgents(leaf, new Set()) as LeafPane;
      expect(result.agentId).toBeNull();
    });

    it('null agents are safe (not cleared)', () => {
      const leaf = createLeaf('p', null);
      const result = validateAgents(leaf, new Set(['agent-1']));
      expect(result).toBe(leaf);
    });

    it('clears projectId when agent is unknown', () => {
      const leaf = createLeaf('p', 'agent-1', 'proj-1');
      const result = validateAgents(leaf, new Set()) as LeafPane;
      expect(result.projectId).toBeUndefined();
    });
  });

  // ── findLeaf ──────────────────────────────────────────────────────────

  describe('findLeaf', () => {
    it('finds a leaf by id', () => {
      const leaf = createLeaf('p');
      expect(findLeaf(leaf, leaf.id)).toBe(leaf);
    });

    it('returns null when not found', () => {
      const leaf = createLeaf('p');
      expect(findLeaf(leaf, 'nonexistent')).toBeNull();
    });

    it('finds nested leaf', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(findLeaf(tree, leaf2.id)).toBe(leaf2);
    });

    it('finds deeply nested leaf', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 's1', direction: 'vertical',
        children: [leaf2, leaf3],
      };
      const outer: SplitPane = {
        type: 'split', id: 's2', direction: 'horizontal',
        children: [leaf1, inner],
      };
      expect(findLeaf(outer, leaf3.id)).toBe(leaf3);
    });
  });

  // ── getFirstLeafId ────────────────────────────────────────────────────

  describe('getFirstLeafId', () => {
    it('returns id of a single leaf', () => {
      const leaf = createLeaf('p');
      expect(getFirstLeafId(leaf)).toBe(leaf.id);
    });

    it('returns leftmost leaf id in split', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(getFirstLeafId(tree)).toBe(leaf1.id);
    });

    it('traverses deeply nested left', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 's1', direction: 'vertical',
        children: [leaf1, leaf2],
      };
      const outer: SplitPane = {
        type: 'split', id: 's2', direction: 'horizontal',
        children: [inner, leaf3],
      };
      expect(getFirstLeafId(outer)).toBe(leaf1.id);
    });
  });

  // ── mapLeaves ─────────────────────────────────────────────────────────

  describe('mapLeaves', () => {
    it('maps a single leaf', () => {
      const leaf = createLeaf('p', null);
      const result = mapLeaves(leaf, (l) => ({ ...l, agentId: 'mapped' })) as LeafPane;
      expect(result.agentId).toBe('mapped');
    });

    it('maps all leaves in a split', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = mapLeaves(tree, (l) => ({ ...l, agentId: 'all' })) as SplitPane;
      expect((result.children[0] as LeafPane).agentId).toBe('all');
      expect((result.children[1] as LeafPane).agentId).toBe('all');
    });

    it('identity map returns new refs for splits', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      const result = mapLeaves(tree, (l) => ({ ...l }));
      expect(result).not.toBe(tree);
    });
  });

  // ── collectLeaves ─────────────────────────────────────────────────────

  describe('collectLeaves', () => {
    it('collects a single leaf', () => {
      const leaf = createLeaf('p');
      expect(collectLeaves(leaf)).toEqual([leaf]);
    });

    it('collects leaves in order', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(collectLeaves(tree)).toEqual([leaf1, leaf2]);
    });

    it('collects leaves from nested tree', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 's1', direction: 'vertical',
        children: [leaf2, leaf3],
      };
      const outer: SplitPane = {
        type: 'split', id: 's2', direction: 'horizontal',
        children: [leaf1, inner],
      };
      expect(collectLeaves(outer)).toEqual([leaf1, leaf2, leaf3]);
    });
  });

  // ── setSplitRatio ───────────────────────────────────────────────────

  describe('setSplitRatio', () => {
    it('sets ratio on a split node', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      const updated = setSplitRatio(result, result.id, 0.7) as SplitPane;
      expect(updated.ratio).toBeCloseTo(0.7);
    });

    it('clamps ratio below 0.15', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      const updated = setSplitRatio(result, result.id, 0.05) as SplitPane;
      expect(updated.ratio).toBeCloseTo(0.15);
    });

    it('clamps ratio above 0.85', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      const updated = setSplitRatio(result, result.id, 0.95) as SplitPane;
      expect(updated.ratio).toBeCloseTo(0.85);
    });

    it('returns same ref when splitId not found', () => {
      const leaf = createLeaf('p');
      const result = setSplitRatio(leaf, 'nonexistent', 0.6);
      expect(result).toBe(leaf);
    });

    it('preserves structural sharing for unchanged branches', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 's_inner', direction: 'vertical', ratio: 0.5,
        children: [leaf2, leaf3],
      };
      const outer: SplitPane = {
        type: 'split', id: 's_outer', direction: 'horizontal', ratio: 0.5,
        children: [leaf1, inner],
      };
      const updated = setSplitRatio(outer, 's_inner', 0.7) as SplitPane;
      expect(updated.children[0]).toBe(leaf1);
      expect((updated.children[1] as SplitPane).ratio).toBeCloseTo(0.7);
    });
  });

  // ── findSplit ─────────────────────────────────────────────────────────

  describe('findSplit', () => {
    it('finds a split by id', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const tree: SplitPane = {
        type: 'split', id: 's1', direction: 'horizontal',
        children: [leaf1, leaf2],
      };
      expect(findSplit(tree, 's1')).toBe(tree);
    });

    it('returns null for leaf', () => {
      const leaf = createLeaf('p');
      expect(findSplit(leaf, 's1')).toBeNull();
    });

    it('finds nested split', () => {
      const leaf1 = createLeaf('p');
      const leaf2 = createLeaf('p');
      const leaf3 = createLeaf('p');
      const inner: SplitPane = {
        type: 'split', id: 's_inner', direction: 'vertical',
        children: [leaf2, leaf3],
      };
      const outer: SplitPane = {
        type: 'split', id: 's_outer', direction: 'horizontal',
        children: [leaf1, inner],
      };
      expect(findSplit(outer, 's_inner')).toBe(inner);
    });
  });

  // ── splitPane ratio ───────────────────────────────────────────────────

  describe('splitPane ratio', () => {
    it('new splits have ratio 0.5', () => {
      const leaf = createLeaf('p');
      const result = splitPane(leaf, leaf.id, 'horizontal', 'p') as SplitPane;
      expect(result.ratio).toBe(0.5);
    });
  });

  // ── backward compatibility ────────────────────────────────────────────

  describe('backward compat (missing ratio)', () => {
    it('old tree without ratio defaults to 0.5 when read', () => {
      const tree: SplitPane = {
        type: 'split', id: 's1', direction: 'horizontal',
        children: [
          { type: 'leaf', id: 'p1', agentId: null },
          { type: 'leaf', id: 'p2', agentId: null },
        ],
      };
      // ratio is undefined, consuming code should use ?? 0.5
      expect(tree.ratio ?? 0.5).toBe(0.5);
    });
  });

  // ── syncCounterToTree ─────────────────────────────────────────────────

  describe('syncCounterToTree', () => {
    it('sets counter above max ID suffix in tree', () => {
      resetPaneCounter(0);
      const tree: LeafPane = { type: 'leaf', id: 'p_15', agentId: null };
      syncCounterToTree(tree);
      // Next ID should be p_16 (counter was set to 15, next is ++15 = 16)
      expect(generatePaneId('p')).toBe('p_16');
    });

    it('does not lower the counter', () => {
      resetPaneCounter(20);
      const tree: LeafPane = { type: 'leaf', id: 'p_5', agentId: null };
      syncCounterToTree(tree);
      expect(generatePaneId('p')).toBe('p_21');
    });

    it('handles split node IDs', () => {
      resetPaneCounter(0);
      const tree: SplitPane = {
        type: 'split', id: 'p_10', direction: 'horizontal',
        children: [
          { type: 'leaf', id: 'p_5', agentId: null },
          { type: 'leaf', id: 'p_8', agentId: null },
        ],
      };
      syncCounterToTree(tree);
      // Max suffix is 10, counter should be 10, next is 11
      expect(generatePaneId('p')).toBe('p_11');
    });
  });
});
