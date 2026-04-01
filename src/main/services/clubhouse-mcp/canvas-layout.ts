/**
 * Canvas layout utilities — pure helper functions for card positioning.
 *
 * All layout algorithms now route through ELK (see elk-layout.ts).
 * This module retains utility functions for grid-based fallback,
 * relative positioning, and card defaults.
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
 * Arrange cards in a grid with roughly sqrt(n) columns.
 * Used internally for zone-contained card arrangement and fallback.
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
