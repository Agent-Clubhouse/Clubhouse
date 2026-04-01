import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  layoutGrid,
  computeRelativePosition,
  DEFAULT_CARD_SIZES,
  type CardInfo,
  type CardRect,
} from './canvas-layout';

const cards: CardInfo[] = [
  { id: 'a', width: 300, height: 200 },
  { id: 'b', width: 300, height: 200 },
  { id: 'c', width: 300, height: 200 },
  { id: 'd', width: 300, height: 200 },
];

describe('canvas-layout', () => {
  describe('snapToGrid', () => {
    it('snaps to nearest 20px grid', () => {
      expect(snapToGrid(0)).toBe(0);
      expect(snapToGrid(10)).toBe(20);
      expect(snapToGrid(19)).toBe(20);
      expect(snapToGrid(20)).toBe(20);
      expect(snapToGrid(30)).toBe(40);
      expect(snapToGrid(105)).toBe(100);
    });
  });

  describe('layoutGrid', () => {
    it('arranges cards in a grid', () => {
      const result = layoutGrid(cards);
      expect(result).toHaveLength(4);
      // sqrt(4) = 2 columns
      expect(result[0].x).toBeLessThan(result[1].x); // same row, different column
      expect(result[2].y).toBeGreaterThan(result[0].y); // different row
    });

    it('returns empty for no cards', () => {
      expect(layoutGrid([])).toHaveLength(0);
    });

    it('snaps all positions to grid', () => {
      const result = layoutGrid(cards);
      for (const r of result) {
        expect(r.x % 20).toBe(0);
        expect(r.y % 20).toBe(0);
      }
    });
  });

  describe('computeRelativePosition', () => {
    const ref: CardRect = { x: 100, y: 200, width: 300, height: 200 };

    it('places card to the right', () => {
      const pos = computeRelativePosition(ref, 'right', 300, 200);
      expect(pos.x).toBe(460); // 100 + 300 + 60 = 460
      expect(pos.y).toBe(200);
    });

    it('places card to the left', () => {
      const pos = computeRelativePosition(ref, 'left', 300, 200);
      expect(pos.x).toBe(snapToGrid(100 - 300 - 60)); // -260 snapped
      expect(pos.y).toBe(200);
    });

    it('places card below', () => {
      const pos = computeRelativePosition(ref, 'below', 300, 200);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(460); // 200 + 200 + 60 = 460
    });

    it('places card above', () => {
      const pos = computeRelativePosition(ref, 'above', 300, 200);
      expect(pos.x).toBe(100);
      expect(pos.y).toBe(snapToGrid(200 - 200 - 60)); // -60 snapped
    });

    it('uses custom buffer', () => {
      const pos = computeRelativePosition(ref, 'right', 300, 200, 20);
      expect(pos.x).toBe(420); // 100 + 300 + 20 = 420
      expect(pos.y).toBe(200);
    });

    it('snaps all results to grid', () => {
      const oddRef: CardRect = { x: 105, y: 213, width: 300, height: 200 };
      for (const direction of ['right', 'left', 'below', 'above'] as const) {
        const pos = computeRelativePosition(oddRef, direction, 300, 200);
        expect(Math.abs(pos.x % 20)).toBe(0);
        expect(Math.abs(pos.y % 20)).toBe(0);
      }
    });

    it('handles different card sizes', () => {
      const pos = computeRelativePosition(ref, 'right', 600, 400);
      expect(pos.x).toBe(460); // 100 + 300 + 60 = 460
      expect(pos.y).toBe(200);

      const posAbove = computeRelativePosition(ref, 'above', 600, 400);
      expect(posAbove.x).toBe(100);
      expect(posAbove.y).toBe(snapToGrid(200 - 400 - 60)); // -260 snapped
    });
  });

  describe('DEFAULT_CARD_SIZES', () => {
    it('defines sizes for standard card types', () => {
      expect(DEFAULT_CARD_SIZES.agent).toEqual({ width: 300, height: 200 });
      expect(DEFAULT_CARD_SIZES.zone).toEqual({ width: 600, height: 400 });
      expect(DEFAULT_CARD_SIZES.anchor).toEqual({ width: 200, height: 100 });
      expect(DEFAULT_CARD_SIZES.sticky).toEqual({ width: 200, height: 150 });
      expect(DEFAULT_CARD_SIZES.plugin).toEqual({ width: 300, height: 200 });
    });
  });
});
