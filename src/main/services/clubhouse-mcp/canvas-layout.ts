/**
 * Canvas layout engine — pure functions for arranging cards.
 *
 * All functions take card positions/sizes and return new positions.
 * No side effects, no store access — fully testable.
 */

export interface CardInfo {
  id: string;
  width: number;
  height: number;
}

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RelativePosition = 'right' | 'left' | 'below' | 'above';

/** Default card dimensions by type. */
export const DEFAULT_CARD_SIZES: Record<string, { width: number; height: number }> = {
  agent: { width: 300, height: 200 },
  zone: { width: 600, height: 400 },
  anchor: { width: 200, height: 100 },
  sticky: { width: 200, height: 150 },
  plugin: { width: 300, height: 200 },
};

export interface LayoutResult {
  id: string;
  x: number;
  y: number;
}

const SPACING = 60;
const GRID_SIZE = 20;

/** Snap a value to the nearest grid point. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

/**
 * Arrange cards in a horizontal row.
 * Cards are placed left-to-right with SPACING between them.
 */
export function layoutHorizontal(cards: CardInfo[], startX = 100, startY = 200): LayoutResult[] {
  let x = startX;
  return cards.map((card) => {
    const result = { id: card.id, x: snapToGrid(x), y: snapToGrid(startY) };
    x += card.width + SPACING;
    return result;
  });
}

/**
 * Arrange cards in a vertical column.
 * Cards are placed top-to-bottom with SPACING between them.
 */
export function layoutVertical(cards: CardInfo[], startX = 200, startY = 100): LayoutResult[] {
  let y = startY;
  return cards.map((card) => {
    const result = { id: card.id, x: snapToGrid(startX), y: snapToGrid(y) };
    y += card.height + SPACING;
    return result;
  });
}

/**
 * Arrange cards in a grid with roughly sqrt(n) columns.
 */
export function layoutGrid(cards: CardInfo[], startX = 100, startY = 100): LayoutResult[] {
  if (cards.length === 0) return [];
  const cols = Math.ceil(Math.sqrt(cards.length));
  const maxWidth = Math.max(...cards.map(c => c.width));
  const maxHeight = Math.max(...cards.map(c => c.height));

  return cards.map((card, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id: card.id,
      x: snapToGrid(startX + col * (maxWidth + SPACING)),
      y: snapToGrid(startY + row * (maxHeight + SPACING)),
    };
  });
}

/**
 * Arrange cards in a hub-spoke pattern.
 * First card is the center hub; remaining cards form a circle around it.
 */
export function layoutHubSpoke(cards: CardInfo[], centerX = 500, centerY = 400): LayoutResult[] {
  if (cards.length === 0) return [];
  if (cards.length === 1) {
    return [{ id: cards[0].id, x: snapToGrid(centerX), y: snapToGrid(centerY) }];
  }

  const results: LayoutResult[] = [];
  // Hub (first card) at center
  results.push({ id: cards[0].id, x: snapToGrid(centerX), y: snapToGrid(centerY) });

  // Spokes arranged in a circle
  const spokes = cards.slice(1);
  const radius = 250;
  const angleStep = (2 * Math.PI) / spokes.length;

  for (let i = 0; i < spokes.length; i++) {
    const angle = angleStep * i - Math.PI / 2; // Start from top
    const x = centerX + radius * Math.cos(angle);
    const y = centerY + radius * Math.sin(angle);
    results.push({ id: spokes[i].id, x: snapToGrid(x), y: snapToGrid(y) });
  }

  return results;
}

/**
 * Compute a position relative to an existing card.
 *
 * @param reference - The card to position relative to (position + size).
 * @param position  - Where to place: 'right', 'left', 'below', 'above'.
 * @param newWidth  - Width of the card being placed.
 * @param newHeight - Height of the card being placed.
 * @param buffer    - Gap between the cards (defaults to SPACING).
 */
export function computeRelativePosition(
  reference: CardRect,
  position: RelativePosition,
  newWidth: number,
  newHeight: number,
  buffer: number = SPACING,
): { x: number; y: number } {
  switch (position) {
    case 'right':
      return {
        x: snapToGrid(reference.x + reference.width + buffer),
        y: snapToGrid(reference.y),
      };
    case 'left':
      return {
        x: snapToGrid(reference.x - newWidth - buffer),
        y: snapToGrid(reference.y),
      };
    case 'below':
      return {
        x: snapToGrid(reference.x),
        y: snapToGrid(reference.y + reference.height + buffer),
      };
    case 'above':
      return {
        x: snapToGrid(reference.x),
        y: snapToGrid(reference.y - newHeight - buffer),
      };
    default:
      return {
        x: snapToGrid(reference.x + reference.width + buffer),
        y: snapToGrid(reference.y),
      };
  }
}

/**
 * Pick the best layout pattern based on card count.
 * - 1-3 cards: horizontal
 * - 4 cards: grid (2x2)
 * - 5-8 cards with a "hub" role: hub_spoke
 * - 5+ cards: grid
 */
export function autoLayout(cards: CardInfo[]): LayoutResult[] {
  if (cards.length <= 3) return layoutHorizontal(cards);
  if (cards.length <= 4) return layoutGrid(cards);
  return layoutGrid(cards);
}

/**
 * Apply a layout pattern to a set of cards.
 */
export function computeLayout(
  pattern: 'horizontal' | 'vertical' | 'grid' | 'hub_spoke' | 'auto',
  cards: CardInfo[],
): LayoutResult[] {
  switch (pattern) {
    case 'horizontal': return layoutHorizontal(cards);
    case 'vertical': return layoutVertical(cards);
    case 'grid': return layoutGrid(cards);
    case 'hub_spoke': return layoutHubSpoke(cards);
    case 'auto': return autoLayout(cards);
    default: return layoutGrid(cards);
  }
}
