import { describe, it, expect } from 'vitest';
import {
  snapToGrid,
  layoutHorizontal,
  layoutVertical,
  layoutGrid,
  layoutHubSpoke,
  layoutForceDirected,
  computeLayout,
  computeRelativePosition,
  autoLayout,
  DEFAULT_CARD_SIZES,
  type CardInfo,
  type CardRect,
  type ForceEdge,
  type ForceZoneConstraint,
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
        // Use Math.abs to handle -0 vs 0 from negative coordinate snapping
        expect(Math.abs(pos.x % 20)).toBe(0);
        expect(Math.abs(pos.y % 20)).toBe(0);
      }
    });

    it('handles different card sizes', () => {
      const pos = computeRelativePosition(ref, 'right', 600, 400);
      // New card's width doesn't affect "right" placement — only ref width + buffer
      expect(pos.x).toBe(460); // 100 + 300 + 60 = 460
      expect(pos.y).toBe(200);

      const posAbove = computeRelativePosition(ref, 'above', 600, 400);
      // "above" uses newHeight, x stays same as reference
      expect(posAbove.x).toBe(100);
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

  describe('layoutForceDirected', () => {
    const cardsWithPos = [
      { id: 'a', width: 300, height: 200, x: 100, y: 100 },
      { id: 'b', width: 300, height: 200, x: 100, y: 100 },
      { id: 'c', width: 300, height: 200, x: 100, y: 100 },
    ];

    it('returns positions for all cards', () => {
      const result = layoutForceDirected(cardsWithPos, []);
      expect(result).toHaveLength(3);
      expect(result.map(r => r.id)).toEqual(['a', 'b', 'c']);
    });

    it('returns empty for no cards', () => {
      expect(layoutForceDirected([], [])).toHaveLength(0);
    });

    it('returns single card at its position', () => {
      const result = layoutForceDirected([cardsWithPos[0]], []);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
    });

    it('spreads overlapping cards apart via repulsion', () => {
      // All cards start at same position
      const result = layoutForceDirected(cardsWithPos, []);
      const positions = new Map(result.map(r => [r.id, { x: r.x, y: r.y }]));

      // After repulsion, cards should be spread apart
      const a = positions.get('a')!;
      const b = positions.get('b')!;
      const dist = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
      expect(dist).toBeGreaterThan(100);
    });

    it('pulls linked cards closer than unlinked ones', () => {
      const edges: ForceEdge[] = [{ source: 'a', target: 'b' }];
      const spreadCards = [
        { id: 'a', width: 300, height: 200, x: 0, y: 0 },
        { id: 'b', width: 300, height: 200, x: 1000, y: 0 },
        { id: 'c', width: 300, height: 200, x: 0, y: 1000 },
      ];

      const result = layoutForceDirected(spreadCards, edges);
      const positions = new Map(result.map(r => [r.id, { x: r.x, y: r.y }]));

      const a = positions.get('a')!;
      const b = positions.get('b')!;
      const c = positions.get('c')!;

      const distAB = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
      const distAC = Math.sqrt((a.x - c.x) ** 2 + (a.y - c.y) ** 2);

      // A-B are linked, so should be closer than A-C (unlinked)
      expect(distAB).toBeLessThan(distAC);
    });

    it('snaps all positions to grid', () => {
      const result = layoutForceDirected(cardsWithPos, []);
      for (const r of result) {
        expect(Math.abs(r.x % 20)).toBe(0);
        expect(Math.abs(r.y % 20)).toBe(0);
      }
    });

    it('respects zone constraints', () => {
      const zoneBounds = { x: 0, y: 0, width: 800, height: 600 };
      const zones: ForceZoneConstraint[] = [{
        zoneId: 'zone1',
        bounds: zoneBounds,
        nodeIds: ['a', 'b'],
      }];

      const result = layoutForceDirected(cardsWithPos, [], {}, zones);
      const a = result.find(r => r.id === 'a')!;
      const b = result.find(r => r.id === 'b')!;

      // Cards a and b should be within zone bounds
      expect(a.x).toBeGreaterThanOrEqual(zoneBounds.x);
      expect(a.x).toBeLessThanOrEqual(zoneBounds.x + zoneBounds.width);
      expect(a.y).toBeGreaterThanOrEqual(zoneBounds.y);
      expect(a.y).toBeLessThanOrEqual(zoneBounds.y + zoneBounds.height);
      expect(b.x).toBeGreaterThanOrEqual(zoneBounds.x);
      expect(b.x).toBeLessThanOrEqual(zoneBounds.x + zoneBounds.width);
    });

    it('accepts custom force parameters', () => {
      // Very high repulsion should spread cards significantly
      const highRepel = layoutForceDirected(cardsWithPos, [], { repelForce: 50000, iterations: 200 });
      const lowRepel = layoutForceDirected(cardsWithPos, [], { repelForce: 500, centerForce: 0.5, iterations: 200 });

      const spreadHigh = computeSpread(highRepel);
      const spreadLow = computeSpread(lowRepel);

      // With high repulsion, cards should spread more than with low repulsion + high center gravity
      expect(spreadHigh).toBeGreaterThan(spreadLow);
    });

    it('handles hub-spoke topology (1 center + N spokes)', () => {
      const hubCards = [
        { id: 'hub', width: 300, height: 200, x: 400, y: 400 },
        { id: 's1', width: 300, height: 200, x: 100, y: 100 },
        { id: 's2', width: 300, height: 200, x: 700, y: 100 },
        { id: 's3', width: 300, height: 200, x: 400, y: 700 },
      ];
      const edges: ForceEdge[] = [
        { source: 'hub', target: 's1' },
        { source: 'hub', target: 's2' },
        { source: 'hub', target: 's3' },
      ];

      const result = layoutForceDirected(hubCards, edges);
      expect(result).toHaveLength(4);

      // All positions should be valid numbers
      for (const r of result) {
        expect(Number.isFinite(r.x)).toBe(true);
        expect(Number.isFinite(r.y)).toBe(true);
      }
    });
  });

  describe('computeLayout with force pattern', () => {
    it('dispatches force pattern and returns positions', () => {
      const result = computeLayout('force', cards);
      expect(result).toHaveLength(4);
      for (const r of result) {
        expect(r.x % 20).toBe(0);
        expect(r.y % 20).toBe(0);
      }
    });

    it('force layout with edges produces valid results', () => {
      const edges: ForceEdge[] = [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'c' },
      ];
      const result = computeLayout('force', cards, edges);
      expect(result).toHaveLength(4);
    });
  });
});

/** Helper: compute total spread (sum of pairwise distances). */
function computeSpread(positions: Array<{ x: number; y: number }>): number {
  let total = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const dx = positions[i].x - positions[j].x;
      const dy = positions[i].y - positions[j].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
  }
  return total;
}
