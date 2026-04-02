import { describe, it, expect } from 'vitest';
import { layoutElk, ElkLayoutInput, resolveOverlaps, pickRootNode } from './elk-layout';

function emptyInput(): ElkLayoutInput {
  return { cards: [], edges: [], zones: [] };
}

describe('elk-layout', () => {
  it('returns empty arrays for empty input', async () => {
    const result = await layoutElk(emptyInput());
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it('positions a single node', async () => {
    const result = await layoutElk({
      cards: [{ id: 'a', width: 200, height: 100 }],
      edges: [],
      zones: [],
    });
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].id).toBe('a');
    expect(typeof result.nodes[0].x).toBe('number');
    expect(typeof result.nodes[0].y).toBe('number');
  });

  it('positions two connected nodes with an edge path', async () => {
    const result = await layoutElk({
      cards: [
        { id: 'a', width: 200, height: 100 },
        { id: 'b', width: 200, height: 100 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      zones: [],
    });
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].id).toBe('e1');
    expect(result.edges[0].path).toMatch(/^M /);
    expect(result.edges[0].path).toMatch(/[CL] /);
  });

  it('returns absolute coordinates for children inside zones', async () => {
    const result = await layoutElk({
      cards: [
        { id: 'c1', width: 150, height: 80, zoneId: 'z1' },
        { id: 'c2', width: 150, height: 80, zoneId: 'z1' },
        { id: 'standalone', width: 150, height: 80 },
      ],
      edges: [{ id: 'e1', source: 'c1', target: 'c2' }],
      zones: [{ id: 'z1', width: 400, height: 200, childIds: ['c1', 'c2'] }],
    });

    // Both zone children and standalone card should appear.
    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['c1', 'c2', 'standalone']);

    // All positions should be non-negative absolute coords.
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('produces valid SVG path strings for edges', async () => {
    const result = await layoutElk({
      cards: [
        { id: 'a', width: 200, height: 100 },
        { id: 'b', width: 200, height: 100 },
        { id: 'c', width: 200, height: 100 },
      ],
      edges: [
        { id: 'e1', source: 'a', target: 'b' },
        { id: 'e2', source: 'b', target: 'c' },
      ],
      zones: [],
    });

    for (const edge of result.edges) {
      expect(edge.path).toBeTruthy();
      expect(edge.path).toMatch(/^M\s/);
      expect(edge.path).toMatch(/[CL]\s/);
    }
  });

  it('snaps node positions to grid (multiples of 20)', async () => {
    const result = await layoutElk({
      cards: [
        { id: 'a', width: 200, height: 100 },
        { id: 'b', width: 200, height: 100 },
      ],
      edges: [{ id: 'e1', source: 'a', target: 'b' }],
      zones: [],
    });

    for (const node of result.nodes) {
      expect(node.x % 20).toBe(0);
      expect(node.y % 20).toBe(0);
    }
  });

  // NOTE: Multi-algorithm tests (radial, force, mrtree) are omitted here because
  // elkjs accumulates internal workers in vitest's thread pool, causing hangs after
  // ~6 ELK instances. All algorithms are validated via tsx integration tests and
  // manual testing. The options are pure configuration passed to ELK — the core
  // layout/flatten/snap pipeline tested above applies identically to all algorithms.
});

describe('resolveOverlaps', () => {
  it('returns positions unchanged when no overlaps exist', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 400, y: 0 },
    ];
    const sizes = new Map([
      ['a', { width: 300, height: 200 }],
      ['b', { width: 300, height: 200 }],
    ]);
    const result = resolveOverlaps(nodes, sizes);
    expect(result).toEqual(nodes);
  });

  it('pushes apart two overlapping cards', () => {
    // Cards at same position — definitely overlapping
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 50, y: 0 },
    ];
    const sizes = new Map([
      ['a', { width: 300, height: 200 }],
      ['b', { width: 300, height: 200 }],
    ]);
    const result = resolveOverlaps(nodes, sizes);

    // After resolution, no AABB overlap should remain
    const ax1 = result[0].x, ay1 = result[0].y;
    const ax2 = ax1 + 300, ay2 = ay1 + 200;
    const bx1 = result[1].x, by1 = result[1].y;
    const bx2 = bx1 + 300, by2 = by1 + 200;

    const overlapX = Math.min(ax2, bx2) - Math.max(ax1, bx1);
    const overlapY = Math.min(ay2, by2) - Math.max(ay1, by1);
    const hasOverlap = overlapX > 0 && overlapY > 0;
    expect(hasOverlap).toBe(false);
  });

  it('resolves overlaps among multiple cards', () => {
    // Three cards stacked at the same position
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 10, y: 10 },
      { id: 'c', x: 20, y: 20 },
    ];
    const sizes = new Map([
      ['a', { width: 200, height: 150 }],
      ['b', { width: 200, height: 150 }],
      ['c', { width: 200, height: 150 }],
    ]);
    const result = resolveOverlaps(nodes, sizes);

    // Check all pairs for no overlap
    for (let i = 0; i < result.length; i++) {
      for (let j = i + 1; j < result.length; j++) {
        const a = result[i], b = result[j];
        const sA = sizes.get(a.id)!;
        const sB = sizes.get(b.id)!;
        const overlapX = Math.min(a.x + sA.width, b.x + sB.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + sA.height, b.y + sB.height) - Math.max(a.y, b.y);
        expect(overlapX > 0 && overlapY > 0).toBe(false);
      }
    }
  });

  it('handles single node without error', () => {
    const result = resolveOverlaps(
      [{ id: 'a', x: 100, y: 100 }],
      new Map([['a', { width: 300, height: 200 }]]),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 'a', x: 100, y: 100 });
  });

  it('handles empty input', () => {
    expect(resolveOverlaps([], new Map())).toEqual([]);
  });

  it('accounts for variable card sizes', () => {
    // Small card overlapping with a much larger card
    const nodes = [
      { id: 'small', x: 0, y: 0 },
      { id: 'large', x: 100, y: 50 },
    ];
    const sizes = new Map([
      ['small', { width: 100, height: 80 }],
      ['large', { width: 600, height: 400 }],
    ]);
    const result = resolveOverlaps(nodes, sizes);

    const a = result.find(n => n.id === 'small')!;
    const b = result.find(n => n.id === 'large')!;
    const overlapX = Math.min(a.x + 100, b.x + 600) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + 80, b.y + 400) - Math.max(a.y, b.y);
    expect(overlapX > 0 && overlapY > 0).toBe(false);
  });

  it('uses default card size when size is missing from map', () => {
    const nodes = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 50, y: 50 },
    ];
    // No sizes provided — should use 300x200 defaults
    const result = resolveOverlaps(nodes, new Map());
    expect(result).toHaveLength(2);
    // Should still resolve — just using default sizes
    const a = result[0], b = result[1];
    const overlapX = Math.min(a.x + 300, b.x + 300) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + 200, b.y + 200) - Math.max(a.y, b.y);
    expect(overlapX > 0 && overlapY > 0).toBe(false);
  });
});

describe('pickRootNode', () => {
  it('returns undefined for empty card list', () => {
    expect(pickRootNode([], [])).toBeUndefined();
  });

  it('returns the only card when there is one', () => {
    expect(pickRootNode([{ id: 'a' }], [])).toBe('a');
  });

  it('picks the most-connected card', () => {
    const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // b is the most connected (degree 2 as source)
    const edges = [
      { source: 'b', target: 'a' },
      { source: 'b', target: 'c' },
    ];
    expect(pickRootNode(cards, edges)).toBe('b');
  });

  it('prefers GP hub card when gpHubIds is provided', () => {
    const cards = [{ id: 'a' }, { id: 'hub' }, { id: 'c' }];
    const edges = [
      { source: 'a', target: 'c' },
      { source: 'a', target: 'hub' },
    ];
    // 'a' has degree 2, 'hub' has degree 1, 'c' has degree 1
    // Without gpHubIds, 'a' would be picked. With gpHubIds, 'hub' should be preferred
    expect(pickRootNode(cards, edges, ['hub'])).toBe('hub');
  });

  it('falls back to most-connected if GP hub has no connections', () => {
    const cards = [{ id: 'a' }, { id: 'hub' }, { id: 'c' }];
    const edges = [
      { source: 'a', target: 'c' },
    ];
    // 'hub' has degree 0, so should fall back to 'a' (degree 1)
    expect(pickRootNode(cards, edges, ['hub'])).toBe('a');
  });

  it('picks the most-connected hub among multiple GP hubs', () => {
    const cards = [{ id: 'a' }, { id: 'hub1' }, { id: 'hub2' }];
    const edges = [
      { source: 'hub1', target: 'a' },
      { source: 'hub2', target: 'a' },
      { source: 'hub2', target: 'hub1' },
    ];
    // hub1 degree=2, hub2 degree=2 — first with max wins
    // Actually hub2: source twice = 2, target 0 => degree 2
    // hub1: source once = 1, target twice = 2 => degree 2? No.
    // hub1: source=1 (to a), target=1 (from hub2) => degree 2
    // hub2: source=2 (to a, to hub1), target=0 => degree 2
    // Equal — first one (hub1) wins
    expect(pickRootNode(cards, edges, ['hub1', 'hub2'])).toBe('hub1');
  });
});
