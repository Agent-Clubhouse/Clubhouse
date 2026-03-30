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
});
