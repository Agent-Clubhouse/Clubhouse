import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  layoutHorizontal,
  layoutVertical,
  layoutGrid,
  layoutHubSpoke,
  computeLayout,
  computeRelativePosition,
  autoLayout,
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

  describe('layoutHorizontal', () => {
    it('arranges cards left-to-right', () => {
      const result = layoutHorizontal(cards, 100, 200);
      expect(result).toHaveLength(4);
      // Each card should be 300 + 60 = 360px apart
      expect(result[0].x).toBe(100);
      expect(result[1].x).toBe(460); // 100 + 300 + 60 = 460
      expect(result[0].y).toBe(200);
      expect(result[1].y).toBe(200);
    });

    it('returns empty for no cards', () => {
      expect(layoutHorizontal([])).toHaveLength(0);
    });
  });

  describe('layoutVertical', () => {
    it('arranges cards top-to-bottom', () => {
      const result = layoutVertical(cards, 200, 100);
      expect(result).toHaveLength(4);
      expect(result[0].y).toBe(100);
      expect(result[1].y).toBe(360); // 100 + 200 + 60 = 360
      expect(result[0].x).toBe(200);
      expect(result[1].x).toBe(200);
    });
  });

  describe('layoutGrid', () => {
    it('arranges cards in a grid', () => {
      const result = layoutGrid(cards);
      expect(result).toHaveLength(4);
      // sqrt(4) = 2 columns
      // Card 0: col 0, row 0
      // Card 1: col 1, row 0
      // Card 2: col 0, row 1
      // Card 3: col 1, row 1
      expect(result[0].x).toBeLessThan(result[1].x); // same row, different column
      expect(result[2].y).toBeGreaterThan(result[0].y); // different row
    });

    it('returns empty for no cards', () => {
      expect(layoutGrid([])).toHaveLength(0);
    });
  });

  describe('layoutHubSpoke', () => {
    it('places first card at center', () => {
      const result = layoutHubSpoke(cards, 500, 400);
      expect(result[0].x).toBe(500);
      expect(result[0].y).toBe(400);
    });

    it('places remaining cards in a circle', () => {
      const result = layoutHubSpoke(cards, 500, 400);
      expect(result).toHaveLength(4);
      // Spokes should be at radius 250 from center
      for (let i = 1; i < result.length; i++) {
        const dx = result[i].x - 500;
        const dy = result[i].y - 400;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // Allow grid snapping tolerance (within 20px of 250)
        expect(dist).toBeGreaterThan(220);
        expect(dist).toBeLessThan(280);
      }
    });

    it('handles single card', () => {
      const result = layoutHubSpoke([cards[0]], 500, 400);
      expect(result).toHaveLength(1);
      expect(result[0].x).toBe(500);
    });
  });

  describe('computeLayout', () => {
    it('dispatches to correct layout function', () => {
      expect(computeLayout('horizontal', cards)).toHaveLength(4);
      expect(computeLayout('vertical', cards)).toHaveLength(4);
      expect(computeLayout('grid', cards)).toHaveLength(4);
      expect(computeLayout('hub_spoke', cards)).toHaveLength(4);
      expect(computeLayout('auto', cards)).toHaveLength(4);
    });

    it('all results have grid-snapped positions', () => {
      for (const pattern of ['horizontal', 'vertical', 'grid', 'hub_spoke', 'auto'] as const) {
        const results = computeLayout(pattern, cards);
        for (const r of results) {
          expect(r.x % 20).toBe(0);
          expect(r.y % 20).toBe(0);
        }
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
      // Use an odd reference position to verify snapping
      const oddRef: CardRect = { x: 105, y: 213, width: 300, height: 200 };
      for (const direction of ['right', 'left', 'below', 'above'] as const) {
        const pos = computeRelativePosition(oddRef, direction, 300, 200);
        expect(pos.x % 20).toBe(0);
        expect(pos.y % 20).toBe(0);
      }
    });

    it('handles different card sizes', () => {
      const pos = computeRelativePosition(ref, 'right', 600, 400);
      // New card's width doesn't affect "right" placement — only ref width + buffer
      expect(pos.x).toBe(460); // 100 + 300 + 60 = 460
      expect(pos.y).toBe(200);

      const posAbove = computeRelativePosition(ref, 'above', 600, 400);
      // "above" uses newHeight
      expect(pos.x).toBe(460);
      expect(posAbove.y).toBe(snapToGrid(200 - 400 - 60)); // -260 snapped
    });
  });

  describe('autoLayout', () => {
    it('uses horizontal for 1-3 cards', () => {
      const twoCards = cards.slice(0, 2);
      const result = autoLayout(twoCards);
      expect(result).toHaveLength(2);
      // Horizontal: same y, increasing x
      expect(result[0].y).toBe(result[1].y);
      expect(result[1].x).toBeGreaterThan(result[0].x);
    });

    it('uses grid for 4 cards', () => {
      const result = autoLayout(cards);
      expect(result).toHaveLength(4);
      // Grid: should have 2 columns — cards 0 and 2 share an x
      expect(result[0].x).toBe(result[2].x);
    });

    it('uses grid for 5+ cards', () => {
      const fiveCards: CardInfo[] = [
        ...cards,
        { id: 'e', width: 300, height: 200 },
      ];
      const result = autoLayout(fiveCards);
      expect(result).toHaveLength(5);
    });

    it('returns empty for no cards', () => {
      expect(autoLayout([])).toHaveLength(0);
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
