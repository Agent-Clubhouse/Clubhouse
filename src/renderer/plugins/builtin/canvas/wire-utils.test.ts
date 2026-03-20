import { describe, it, expect } from 'vitest';
import { closestEdgeMidpoint, bezierPath, bezierPathWithOffsets, computeWirePath, viewRect, type Rect, type EdgeMidpoint } from './wire-utils';

describe('closestEdgeMidpoint', () => {
  const rect: Rect = { x: 100, y: 100, width: 200, height: 100 };

  it('picks right edge when target is to the right', () => {
    const target: Rect = { x: 400, y: 100, width: 100, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('right');
    expect(result.x).toBe(300); // rect.x + rect.width
    expect(result.y).toBe(150); // rect.y + rect.height / 2
  });

  it('picks left edge when target is to the left', () => {
    const target: Rect = { x: -100, y: 100, width: 100, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('left');
    expect(result.x).toBe(100);
  });

  it('picks bottom edge when target is below', () => {
    const target: Rect = { x: 100, y: 400, width: 200, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('bottom');
    expect(result.y).toBe(200); // rect.y + rect.height
  });

  it('picks top edge when target is above', () => {
    const target: Rect = { x: 100, y: -200, width: 200, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('top');
    expect(result.y).toBe(100);
  });

  it('picks horizontal edge for diagonal (NE) — horizontal dominant', () => {
    const target: Rect = { x: 500, y: 50, width: 100, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('right');
  });

  it('picks vertical edge for diagonal (SW) — vertical dominant', () => {
    const target: Rect = { x: 80, y: 500, width: 100, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('bottom');
  });

  it('defaults to right edge when widgets overlap perfectly', () => {
    const target: Rect = { x: 100, y: 100, width: 200, height: 100 };
    const result = closestEdgeMidpoint(rect, target);
    expect(result.edge).toBe('right');
  });
});

describe('bezierPath', () => {
  it('returns a valid SVG cubic bezier path', () => {
    const from: EdgeMidpoint = { x: 100, y: 150, edge: 'right' };
    const to: EdgeMidpoint = { x: 300, y: 150, edge: 'left' };
    const path = bezierPath(from, to);
    expect(path).toMatch(/^M\s/);
    expect(path).toContain('C');
    // Should start at from and end at to
    expect(path).toMatch(/M\s100\s150/);
    expect(path).toMatch(/300\s150$/);
  });

  it('control points extend along exit direction', () => {
    const from: EdgeMidpoint = { x: 0, y: 0, edge: 'bottom' };
    const to: EdgeMidpoint = { x: 100, y: 100, edge: 'top' };
    const path = bezierPath(from, to);
    // from.edge = bottom → cp1 offset (0, 80), to.edge = top → cp2 offset (0, -80)
    expect(path).toContain('C 0 80');
    expect(path).toContain('100 20');
  });
});

describe('viewRect', () => {
  it('creates rect from position and size', () => {
    const r = viewRect({ x: 10, y: 20 }, { width: 100, height: 50 });
    expect(r).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });
});

describe('bezierPathWithOffsets', () => {
  it('returns same as bezierPath when offsets are zero', () => {
    const from: EdgeMidpoint = { x: 100, y: 150, edge: 'right' };
    const to: EdgeMidpoint = { x: 300, y: 150, edge: 'left' };
    const withOffsets = bezierPathWithOffsets(from, to, { dx: 0, dy: 0 }, { dx: 0, dy: 0 });
    const without = bezierPath(from, to);
    expect(withOffsets).toBe(without);
  });

  it('applies offsets to control points only, not endpoints', () => {
    const from: EdgeMidpoint = { x: 0, y: 0, edge: 'right' };
    const to: EdgeMidpoint = { x: 200, y: 0, edge: 'left' };
    const path = bezierPathWithOffsets(from, to, { dx: 5, dy: 10 }, { dx: -3, dy: 7 });
    // Endpoints stay at (0,0) and (200,0)
    expect(path).toMatch(/^M 0 0 C/);
    expect(path).toMatch(/200 0$/);
    // Control points should include offsets: right edge → cp1 (80+5, 0+10), left edge → cp2 (-80-3, 0+7)
    expect(path).toContain('85 10');
    expect(path).toContain('117 7');
  });
});

describe('computeWirePath', () => {
  it('returns a path connecting two rects', () => {
    const src: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const tgt: Rect = { x: 300, y: 0, width: 100, height: 100 };
    const result = computeWirePath(src, tgt);
    expect(result.path).toBeTruthy();
    expect(result.from.edge).toBe('right');
    expect(result.to.edge).toBe('left');
  });

  it('handles vertically stacked rects', () => {
    const src: Rect = { x: 0, y: 0, width: 100, height: 100 };
    const tgt: Rect = { x: 0, y: 300, width: 100, height: 100 };
    const result = computeWirePath(src, tgt);
    expect(result.from.edge).toBe('bottom');
    expect(result.to.edge).toBe('top');
  });
});
