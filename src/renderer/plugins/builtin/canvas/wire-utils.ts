/**
 * Wire Utilities — edge midpoint computation and SVG bezier path generation
 * for canvas wires connecting agent widgets to their MCP binding targets.
 */

import type { Position, Size } from './canvas-types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Edge = 'top' | 'bottom' | 'left' | 'right';

export interface EdgeMidpoint {
  x: number;
  y: number;
  edge: Edge;
}

/**
 * Compute the center of a rect.
 */
function center(r: Rect): Position {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

/**
 * For a given rect, pick the edge whose midpoint is closest to `target` center.
 * Returns the midpoint position and which edge was picked.
 */
export function closestEdgeMidpoint(rect: Rect, target: Rect): EdgeMidpoint {
  const tc = center(target);
  const rc = center(rect);

  const dx = tc.x - rc.x;
  const dy = tc.y - rc.y;

  // Compare the normalized direction to decide horizontal vs vertical edge
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // When widgets overlap perfectly (same center), default to right edge
  if (absDx === 0 && absDy === 0) {
    return { x: rect.x + rect.width, y: rect.y + rect.height / 2, edge: 'right' };
  }

  if (absDx >= absDy) {
    // Horizontal: use left or right edge
    if (dx >= 0) {
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2, edge: 'right' };
    } else {
      return { x: rect.x, y: rect.y + rect.height / 2, edge: 'left' };
    }
  } else {
    // Vertical: use top or bottom edge
    if (dy >= 0) {
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height, edge: 'bottom' };
    } else {
      return { x: rect.x + rect.width / 2, y: rect.y, edge: 'top' };
    }
  }
}

/**
 * Control point offset along the exit direction for bezier curves.
 */
const CP_DISTANCE = 80;

export function controlPointOffset(edge: Edge): Position {
  switch (edge) {
    case 'top':    return { x: 0, y: -CP_DISTANCE };
    case 'bottom': return { x: 0, y: CP_DISTANCE };
    case 'left':   return { x: -CP_DISTANCE, y: 0 };
    case 'right':  return { x: CP_DISTANCE, y: 0 };
  }
}

/**
 * Generate an SVG cubic bezier path string between two edge midpoints.
 * Control points extend along the exit direction of each edge.
 */
export function bezierPath(from: EdgeMidpoint, to: EdgeMidpoint): string {
  const cp1 = controlPointOffset(from.edge);
  const cp2 = controlPointOffset(to.edge);
  return `M ${from.x} ${from.y} C ${from.x + cp1.x} ${from.y + cp1.y}, ${to.x + cp2.x} ${to.y + cp2.y}, ${to.x} ${to.y}`;
}

/**
 * Build a rect from a view's position and size.
 */
export function viewRect(position: Position, size: Size): Rect {
  return { x: position.x, y: position.y, width: size.width, height: size.height };
}

/**
 * Compute the wire path between two view rects.
 * Returns the SVG path string and the two endpoints.
 */
export function computeWirePath(
  sourceRect: Rect,
  targetRect: Rect,
): { path: string; from: EdgeMidpoint; to: EdgeMidpoint } {
  const from = closestEdgeMidpoint(sourceRect, targetRect);
  const to = closestEdgeMidpoint(targetRect, sourceRect);
  return { path: bezierPath(from, to), from, to };
}

/**
 * Generate a bezier path with physics offsets applied to control points only.
 * Endpoints stay anchored to view edges; offsets affect the curve's shape.
 */
export function bezierPathWithOffsets(
  from: EdgeMidpoint,
  to: EdgeMidpoint,
  fromOffset: { dx: number; dy: number },
  toOffset: { dx: number; dy: number },
): string {
  const cp1 = controlPointOffset(from.edge);
  const cp2 = controlPointOffset(to.edge);
  return `M ${from.x} ${from.y} C ${from.x + cp1.x + fromOffset.dx} ${from.y + cp1.y + fromOffset.dy}, ${to.x + cp2.x + toOffset.dx} ${to.y + cp2.y + toOffset.dy}, ${to.x} ${to.y}`;
}
