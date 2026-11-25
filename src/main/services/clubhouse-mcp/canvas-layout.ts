/**
 * Canvas layout utilities. Layout algorithms run through ELK (see elk-layout.ts);
 * this module keeps the grid snap they share.
 */

const GRID_SIZE = 20;

/** Snap a value to the nearest grid point. */
export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}
