import { describe, it, expect } from 'vitest';
import type { PaneNode, LeafPane, SplitPane } from './pane-tree';
import {
  flattenPaneTree,
  buildCanvasViews,
  convertHubToCanvas,
  convertAllHubsToCanvases,
  generateDuplicateHubName,
  clonePaneTree,
} from './hub-to-canvas';
import type { HubInstance } from './useHubStore';
import { GRID_SIZE } from '../canvas/canvas-types';

// ── Helper builders ──────────────────────────────────────────────────

function leaf(id: string, agentId: string | null = null, projectId?: string): LeafPane {
  return { type: 'leaf', id, agentId, projectId };
}

function split(
  id: string,
  direction: 'horizontal' | 'vertical',
  children: [PaneNode, PaneNode],
  ratio = 0.5,
): SplitPane {
  return { type: 'split', id, direction, children, ratio };
}

// ── flattenPaneTree ──────────────────────────────────────────────────

describe('flattenPaneTree', () => {
  it('returns a single pane for a leaf node', () => {
    const result = flattenPaneTree(leaf('p1', 'agent-1'), 0, 0, 800, 600);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBe('agent-1');
    expect(result[0].size.width).toBe(800);
    expect(result[0].size.height).toBe(600);
  });

  it('preserves empty panes (null agentId)', () => {
    const result = flattenPaneTree(leaf('p1', null), 0, 0, 800, 600);
    expect(result).toHaveLength(1);
    expect(result[0].agentId).toBeNull();
  });

  it('preserves projectId on panes', () => {
    const result = flattenPaneTree(leaf('p1', 'a1', 'proj-1'), 0, 0, 800, 600);
    expect(result[0].projectId).toBe('proj-1');
  });

  it('splits horizontally into two panes', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const result = flattenPaneTree(tree, 0, 0, 1000, 600);
    expect(result).toHaveLength(2);

    // Both should have the same height
    expect(result[0].size.height).toBe(600);
    expect(result[1].size.height).toBe(600);

    // Widths should roughly sum to total minus gutter
    const totalWidth = result[0].size.width + result[1].size.width;
    expect(totalWidth).toBeLessThanOrEqual(1000);
    expect(totalWidth).toBeGreaterThanOrEqual(1000 - GRID_SIZE * 2); // accounting for snap

    // Second pane should be positioned to the right
    expect(result[1].position.x).toBeGreaterThan(result[0].position.x);
  });

  it('splits vertically into two panes', () => {
    const tree = split('s1', 'vertical', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const result = flattenPaneTree(tree, 0, 0, 800, 1000);
    expect(result).toHaveLength(2);

    // Both should have the same width
    expect(result[0].size.width).toBe(800);
    expect(result[1].size.width).toBe(800);

    // Second pane should be positioned below
    expect(result[1].position.y).toBeGreaterThan(result[0].position.y);
  });

  it('respects custom split ratios', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ], 0.7);
    const result = flattenPaneTree(tree, 0, 0, 1000, 600);

    // First pane should be wider than second (70/30 split)
    expect(result[0].size.width).toBeGreaterThan(result[1].size.width);
  });

  it('handles nested splits (2x2 grid)', () => {
    const tree = split('s1', 'horizontal', [
      split('s2', 'vertical', [leaf('p1', 'a1'), leaf('p2', 'a2')]),
      split('s3', 'vertical', [leaf('p3', 'a3'), leaf('p4', 'a4')]),
    ]);
    const result = flattenPaneTree(tree, 0, 0, 1000, 1000);
    expect(result).toHaveLength(4);

    // All four agents should be present
    const agentIds = result.map((r) => r.agentId);
    expect(agentIds).toEqual(['a1', 'a2', 'a3', 'a4']);
  });

  it('enforces minimum pane dimensions', () => {
    // Very small reference size — panes should still be at least 200x150
    const result = flattenPaneTree(leaf('p1', 'a1'), 0, 0, 50, 50);
    expect(result[0].size.width).toBeGreaterThanOrEqual(200);
    expect(result[0].size.height).toBeGreaterThanOrEqual(150);
  });

  it('snaps positions to grid', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ], 0.33);
    const result = flattenPaneTree(tree, 0, 0, 1000, 600);
    for (const pane of result) {
      expect(pane.position.x % GRID_SIZE).toBe(0);
      expect(pane.position.y % GRID_SIZE).toBe(0);
      expect(pane.size.width % GRID_SIZE).toBe(0);
      expect(pane.size.height % GRID_SIZE).toBe(0);
    }
  });

  it('handles deeply nested tree', () => {
    // A -> B (left) | (right: C -> D (top) | E (bottom))
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      split('s2', 'vertical', [
        leaf('p2', 'a2'),
        leaf('p3', 'a3'),
      ]),
    ]);
    const result = flattenPaneTree(tree, 0, 0, 1200, 800);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.agentId)).toEqual(['a1', 'a2', 'a3']);
  });
});

// ── buildCanvasViews ─────────────────────────────────────────────────

describe('buildCanvasViews', () => {
  it('returns empty array for empty input', () => {
    expect(buildCanvasViews([])).toEqual([]);
  });

  it('creates agent canvas views from flattened panes', () => {
    const panes = flattenPaneTree(leaf('p1', 'a1'), 0, 0, 800, 600);
    const views = buildCanvasViews(panes);
    expect(views).toHaveLength(1);
    expect(views[0].type).toBe('agent');
    expect(views[0].agentId).toBe('a1');
  });

  it('centers views around origin', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const panes = flattenPaneTree(tree, 0, 0, 800, 600);
    const views = buildCanvasViews(panes);

    // Compute bounding box center — should be near (0,0)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const v of views) {
      minX = Math.min(minX, v.position.x);
      minY = Math.min(minY, v.position.y);
      maxX = Math.max(maxX, v.position.x + v.size.width);
      maxY = Math.max(maxY, v.position.y + v.size.height);
    }
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    // Center should be within one grid unit of origin
    expect(Math.abs(centerX)).toBeLessThanOrEqual(GRID_SIZE);
    expect(Math.abs(centerY)).toBeLessThanOrEqual(GRID_SIZE);
  });

  it('deduplicates display names', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const panes = flattenPaneTree(tree, 0, 0, 800, 600);
    const views = buildCanvasViews(panes);
    expect(views[0].displayName).toBe('Agent');
    expect(views[1].displayName).toBe('Agent (2)');
  });

  it('preserves null agentId for empty panes', () => {
    const panes = flattenPaneTree(leaf('p1', null), 0, 0, 800, 600);
    const views = buildCanvasViews(panes);
    expect(views[0].agentId).toBeNull();
  });

  it('preserves projectId', () => {
    const panes = flattenPaneTree(leaf('p1', 'a1', 'proj-x'), 0, 0, 800, 600);
    const views = buildCanvasViews(panes);
    expect(views[0].projectId).toBe('proj-x');
  });

  it('assigns sequential z-indexes', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      split('s2', 'vertical', [leaf('p2', 'a2'), leaf('p3', 'a3')]),
    ]);
    const panes = flattenPaneTree(tree, 0, 0, 1000, 600);
    const views = buildCanvasViews(panes);
    expect(views.map((v) => v.zIndex)).toEqual([0, 1, 2]);
  });

  it('generates unique IDs for each view', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const panes = flattenPaneTree(tree, 0, 0, 800, 600);
    const views = buildCanvasViews(panes);
    expect(views[0].id).not.toBe(views[1].id);
    expect(views[0].id).toMatch(/^cv_/);
  });
});

// ── convertHubToCanvas ───────────────────────────────────────────────

describe('convertHubToCanvas', () => {
  it('creates a canvas instance with correct name (upgrade mode)', () => {
    const result = convertHubToCanvas({
      hubName: 'My Hub',
      paneTree: leaf('p1', 'a1'),
      referenceWidth: 800,
      referenceHeight: 600,
      deleteOriginal: false,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(result.name).toBe('My Hub-upgraded');
    expect(result.views).toHaveLength(1);
    expect(result.id).toMatch(/^canvas_/);
  });

  it('creates a canvas with original name (upgrade & delete mode)', () => {
    const result = convertHubToCanvas({
      hubName: 'My Hub',
      paneTree: leaf('p1', 'a1'),
      referenceWidth: 800,
      referenceHeight: 600,
      deleteOriginal: true,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(result.name).toBe('My Hub');
  });

  it('sets viewport to fit all views', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const result = convertHubToCanvas({
      hubName: 'Hub',
      paneTree: tree,
      referenceWidth: 1200,
      referenceHeight: 800,
      deleteOriginal: false,
      containerWidth: 1200,
      containerHeight: 800,
    });
    expect(result.viewport).toBeDefined();
    expect(result.viewport.zoom).toBeGreaterThan(0);
    expect(result.viewport.zoom).toBeLessThanOrEqual(1);
  });

  it('sets nextZIndex to number of views', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ]);
    const result = convertHubToCanvas({
      hubName: 'Hub',
      paneTree: tree,
      referenceWidth: 800,
      referenceHeight: 600,
      deleteOriginal: false,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(result.nextZIndex).toBe(2);
  });

  it('preserves agent assignments in converted views', () => {
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1', 'proj-1'),
      leaf('p2', 'a2', 'proj-2'),
    ]);
    const result = convertHubToCanvas({
      hubName: 'Hub',
      paneTree: tree,
      referenceWidth: 800,
      referenceHeight: 600,
      deleteOriginal: false,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(result.views[0].agentId).toBe('a1');
    expect(result.views[0].projectId).toBe('proj-1');
    expect(result.views[1].agentId).toBe('a2');
    expect(result.views[1].projectId).toBe('proj-2');
  });

  it('handles complex 2x2 hub layout', () => {
    const tree = split('s1', 'vertical', [
      split('s2', 'horizontal', [leaf('p1', 'a1'), leaf('p2', 'a2')]),
      split('s3', 'horizontal', [leaf('p3', 'a3'), leaf('p4', null)]),
    ]);
    const result = convertHubToCanvas({
      hubName: 'Complex Hub',
      paneTree: tree,
      referenceWidth: 1200,
      referenceHeight: 800,
      deleteOriginal: true,
      containerWidth: 1200,
      containerHeight: 800,
    });
    expect(result.name).toBe('Complex Hub');
    expect(result.views).toHaveLength(4);
    expect(result.views[3].agentId).toBeNull(); // empty pane preserved
  });

  it('initializes zoomedViewId and selectedViewId as null', () => {
    const result = convertHubToCanvas({
      hubName: 'Hub',
      paneTree: leaf('p1', 'a1'),
      referenceWidth: 800,
      referenceHeight: 600,
      deleteOriginal: false,
      containerWidth: 800,
      containerHeight: 600,
    });
    expect(result.zoomedViewId).toBeNull();
    expect(result.selectedViewId).toBeNull();
  });
});

// ── convertAllHubsToCanvases ─────────────────────────────────────────

function hubInstance(id: string, name: string, paneTree: PaneNode): HubInstance {
  return { id, name, paneTree, focusedPaneId: 'p1', zoomedPaneId: null };
}

describe('convertAllHubsToCanvases', () => {
  it('converts app-level hubs to canvases', () => {
    const hubs = {
      app: [hubInstance('h1', 'App Hub', leaf('p1', 'a1'))],
      projects: new Map<string, HubInstance[]>(),
    };
    const result = convertAllHubsToCanvases(hubs, 800, 600);
    expect(result.app).toHaveLength(1);
    expect(result.app[0].name).toBe('App Hub');
    expect(result.app[0].views).toHaveLength(1);
    expect(result.projects.size).toBe(0);
  });

  it('converts per-project hubs to canvases', () => {
    const projectHubs = new Map<string, HubInstance[]>();
    projectHubs.set('proj-1', [
      hubInstance('h1', 'Hub A', leaf('p1', 'a1')),
      hubInstance('h2', 'Hub B', split('s1', 'horizontal', [leaf('p2', 'a2'), leaf('p3', 'a3')])),
    ]);

    const hubs = { app: [], projects: projectHubs };
    const result = convertAllHubsToCanvases(hubs, 800, 600);

    expect(result.app).toHaveLength(0);
    expect(result.projects.get('proj-1')).toHaveLength(2);
    expect(result.projects.get('proj-1')![0].name).toBe('Hub A');
    expect(result.projects.get('proj-1')![1].name).toBe('Hub B');
    expect(result.projects.get('proj-1')![1].views).toHaveLength(2);
  });

  it('handles multiple projects', () => {
    const projectHubs = new Map<string, HubInstance[]>();
    projectHubs.set('proj-1', [hubInstance('h1', 'P1 Hub', leaf('p1', 'a1'))]);
    projectHubs.set('proj-2', [hubInstance('h2', 'P2 Hub', leaf('p2', 'a2'))]);

    const hubs = { app: [], projects: projectHubs };
    const result = convertAllHubsToCanvases(hubs, 800, 600);

    expect(result.projects.size).toBe(2);
    expect(result.projects.get('proj-1')).toHaveLength(1);
    expect(result.projects.get('proj-2')).toHaveLength(1);
  });

  it('handles empty input', () => {
    const hubs = { app: [], projects: new Map<string, HubInstance[]>() };
    const result = convertAllHubsToCanvases(hubs, 800, 600);
    expect(result.app).toHaveLength(0);
    expect(result.projects.size).toBe(0);
  });

  it('uses deleteOriginal=false (canvas name has no suffix)', () => {
    const hubs = {
      app: [hubInstance('h1', 'My Hub', leaf('p1', 'a1'))],
      projects: new Map<string, HubInstance[]>(),
    };
    const result = convertAllHubsToCanvases(hubs, 800, 600);
    // deleteOriginal=false → name gets "-upgraded" suffix
    expect(result.app[0].name).toBe('My Hub');
  });
});

// ── generateDuplicateHubName ─────────────────────────────────────────

describe('generateDuplicateHubName', () => {
  it('generates -2 suffix for first duplicate', () => {
    expect(generateDuplicateHubName('My Hub', ['My Hub'])).toBe('My Hub-2');
  });

  it('increments suffix to avoid collision', () => {
    expect(generateDuplicateHubName('Hub', ['Hub', 'Hub-2', 'Hub-3'])).toBe('Hub-4');
  });

  it('starts at -2 even if base name is not in list', () => {
    expect(generateDuplicateHubName('New', ['Other'])).toBe('New-2');
  });
});

// ── clonePaneTree ────────────────────────────────────────────────────

describe('clonePaneTree', () => {
  it('clones a leaf with new ID', () => {
    let counter = 0;
    const result = clonePaneTree(leaf('p1', 'a1', 'proj-1'), () => `new_${++counter}`);
    expect(result.type).toBe('leaf');
    expect(result.id).toBe('new_1');
    expect((result as LeafPane).agentId).toBe('a1');
    expect((result as LeafPane).projectId).toBe('proj-1');
  });

  it('clones a split tree with new IDs for all nodes', () => {
    let counter = 0;
    const tree = split('s1', 'horizontal', [
      leaf('p1', 'a1'),
      leaf('p2', 'a2'),
    ], 0.7);
    const result = clonePaneTree(tree, () => `new_${++counter}`);

    expect(result.type).toBe('split');
    const sp = result as SplitPane;
    expect(sp.direction).toBe('horizontal');
    expect(sp.ratio).toBe(0.7);
    expect(sp.children[0].type).toBe('leaf');
    expect(sp.children[1].type).toBe('leaf');

    // All IDs should be new — split ID is generated before children
    expect(sp.id).toBe('new_1');
    expect(sp.children[0].id).toBe('new_2');
    expect(sp.children[1].id).toBe('new_3');

    // Agent assignments preserved
    expect((sp.children[0] as LeafPane).agentId).toBe('a1');
    expect((sp.children[1] as LeafPane).agentId).toBe('a2');
  });

  it('preserves null agentId in cloned leaves', () => {
    let counter = 0;
    const result = clonePaneTree(leaf('p1', null), () => `n_${++counter}`);
    expect((result as LeafPane).agentId).toBeNull();
  });

  it('deeply clones nested structure', () => {
    let counter = 0;
    const tree = split('s1', 'horizontal', [
      split('s2', 'vertical', [leaf('p1', 'a1'), leaf('p2', 'a2')]),
      leaf('p3', 'a3'),
    ]);
    const result = clonePaneTree(tree, () => `c_${++counter}`);

    // Original IDs should NOT appear in clone
    const collectIds = (node: PaneNode): string[] => {
      if (node.type === 'leaf') return [node.id];
      return [node.id, ...collectIds(node.children[0]), ...collectIds(node.children[1])];
    };
    const origIds = collectIds(tree);
    const cloneIds = collectIds(result);
    for (const id of cloneIds) {
      expect(origIds).not.toContain(id);
    }
  });
});
