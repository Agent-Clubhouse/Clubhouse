import { describe, it, expect } from 'vitest';
import { layoutElk, ElkLayoutInput } from './elk-layout';

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

    const ids = result.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['c1', 'c2', 'standalone']);

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

  // ── Multi-algorithm tests ──────────────────────────────────────────

  describe('layered algorithm', () => {
    it('uses layered by default', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
      });
      // Default is layered RIGHT — b should be to the right of a
      const a = result.nodes.find(n => n.id === 'a')!;
      const b = result.nodes.find(n => n.id === 'b')!;
      expect(b.x).toBeGreaterThan(a.x);
    });

    it('respects direction DOWN', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
        options: { algorithm: 'layered', direction: 'DOWN' },
      });
      const a = result.nodes.find(n => n.id === 'a')!;
      const b = result.nodes.find(n => n.id === 'b')!;
      expect(b.y).toBeGreaterThan(a.y);
    });

    it('respects direction LEFT', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
        options: { algorithm: 'layered', direction: 'LEFT' },
      });
      const a = result.nodes.find(n => n.id === 'a')!;
      const b = result.nodes.find(n => n.id === 'b')!;
      expect(b.x).toBeLessThan(a.x);
    });

    it('respects direction UP', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
        options: { algorithm: 'layered', direction: 'UP' },
      });
      const a = result.nodes.find(n => n.id === 'a')!;
      const b = result.nodes.find(n => n.id === 'b')!;
      expect(b.y).toBeLessThan(a.y);
    });
  });

  describe('radial algorithm', () => {
    it('positions nodes in a radial layout', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'hub', width: 200, height: 100 },
          { id: 's1', width: 200, height: 100 },
          { id: 's2', width: 200, height: 100 },
          { id: 's3', width: 200, height: 100 },
        ],
        edges: [
          { id: 'e1', source: 'hub', target: 's1' },
          { id: 'e2', source: 'hub', target: 's2' },
          { id: 'e3', source: 'hub', target: 's3' },
        ],
        zones: [],
        options: { algorithm: 'radial' },
      });
      expect(result.nodes).toHaveLength(4);
      for (const node of result.nodes) {
        expect(node.x % 20).toBe(0);
        expect(node.y % 20).toBe(0);
      }
    });

    it('accepts a root node ID', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
          { id: 'c', width: 200, height: 100 },
        ],
        edges: [
          { id: 'e1', source: 'a', target: 'b' },
          { id: 'e2', source: 'a', target: 'c' },
        ],
        zones: [],
        options: { algorithm: 'radial', rootId: 'a' },
      });
      expect(result.nodes).toHaveLength(3);
    });
  });

  describe('force algorithm', () => {
    it('positions nodes using force-directed layout', async () => {
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
        options: { algorithm: 'force' },
      });
      expect(result.nodes).toHaveLength(3);
      for (const node of result.nodes) {
        expect(Number.isFinite(node.x)).toBe(true);
        expect(Number.isFinite(node.y)).toBe(true);
      }
    });
  });

  describe('mrtree algorithm', () => {
    it('positions nodes in a tree layout', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'root', width: 200, height: 100 },
          { id: 'child1', width: 200, height: 100 },
          { id: 'child2', width: 200, height: 100 },
          { id: 'grandchild', width: 200, height: 100 },
        ],
        edges: [
          { id: 'e1', source: 'root', target: 'child1' },
          { id: 'e2', source: 'root', target: 'child2' },
          { id: 'e3', source: 'child1', target: 'grandchild' },
        ],
        zones: [],
        options: { algorithm: 'mrtree' },
      });
      expect(result.nodes).toHaveLength(4);
      for (const node of result.nodes) {
        expect(node.x % 20).toBe(0);
        expect(node.y % 20).toBe(0);
      }
    });

    it('respects direction for mrtree', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'root', width: 200, height: 100 },
          { id: 'child', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'root', target: 'child' }],
        zones: [],
        options: { algorithm: 'mrtree', direction: 'RIGHT' },
      });
      const root = result.nodes.find(n => n.id === 'root')!;
      const child = result.nodes.find(n => n.id === 'child')!;
      expect(child.x).toBeGreaterThan(root.x);
    });
  });

  describe('options defaults', () => {
    it('defaults to layered algorithm when options omitted', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
      });
      // Should succeed and produce valid results
      expect(result.nodes).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
    });

    it('defaults to layered algorithm when options.algorithm omitted', async () => {
      const result = await layoutElk({
        cards: [
          { id: 'a', width: 200, height: 100 },
          { id: 'b', width: 200, height: 100 },
        ],
        edges: [{ id: 'e1', source: 'a', target: 'b' }],
        zones: [],
        options: {} as any,
      });
      expect(result.nodes).toHaveLength(2);
    });
  });
});
