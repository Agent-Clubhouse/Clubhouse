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

// ── Force-Directed Layout ─────────────────────────────────────────────────

/** Edge between two nodes for force-directed layout. */
export interface ForceEdge {
  source: string;
  target: string;
}

/** Zone constraint for force-directed layout. */
export interface ForceZoneConstraint {
  zoneId: string;
  bounds: CardRect;
  nodeIds: string[];
}

/** Tunable parameters for force-directed layout. */
export interface ForceLayoutParams {
  /** Strength of center-pulling force (0-1). Default 0.1. */
  centerForce?: number;
  /** Strength of node repulsion (higher = more spread). Default 5000. */
  repelForce?: number;
  /** Strength of edge attraction (0-1). Default 0.3. */
  linkForce?: number;
  /** Ideal distance between linked nodes. Default 300. */
  linkDistance?: number;
  /** Number of simulation iterations. Default 100. */
  iterations?: number;
}

const DEFAULT_FORCE_PARAMS: Required<ForceLayoutParams> = {
  centerForce: 0.1,
  repelForce: 5000,
  linkForce: 0.3,
  linkDistance: 300,
  iterations: 100,
};

interface ForceNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
}

/**
 * Force-directed layout using Fruchterman-Reingold-inspired physics.
 *
 * Forces applied each iteration:
 *   1. Center gravity — pulls all nodes toward the center of mass
 *   2. Node repulsion — pushes overlapping/close nodes apart (inverse square)
 *   3. Edge attraction — pulls connected nodes toward ideal link distance
 *
 * Zone constraints are enforced after each iteration: nodes assigned to a zone
 * are clamped to remain within that zone's bounds.
 *
 * @param cards - Cards with initial positions (x, y from CardRect).
 * @param edges - Wires/connections between cards.
 * @param params - Tunable force parameters.
 * @param zones - Zone constraints (cards must stay within zone bounds).
 * @returns Final positions for each card, snapped to grid.
 */
export function layoutForceDirected(
  cards: Array<CardInfo & { x: number; y: number }>,
  edges: ForceEdge[],
  params: ForceLayoutParams = {},
  zones: ForceZoneConstraint[] = [],
): LayoutResult[] {
  if (cards.length === 0) return [];
  if (cards.length === 1) {
    return [{ id: cards[0].id, x: snapToGrid(cards[0].x), y: snapToGrid(cards[0].y) }];
  }

  const p = { ...DEFAULT_FORCE_PARAMS, ...params };

  // Initialize nodes with positions and zero velocity.
  // Add small deterministic jitter to break symmetry when cards overlap.
  const nodes: ForceNode[] = cards.map((c, i) => ({
    id: c.id,
    x: c.x + (i * 7 % 13) * 10 - 60,
    y: c.y + (i * 11 % 13) * 10 - 60,
    width: c.width,
    height: c.height,
    vx: 0,
    vy: 0,
  }));

  // Build zone membership lookup: nodeId → zone constraint
  const nodeZone = new Map<string, ForceZoneConstraint>();
  for (const zone of zones) {
    for (const nid of zone.nodeIds) {
      nodeZone.set(nid, zone);
    }
  }

  // Compute center of mass
  const centerX = nodes.reduce((s, n) => s + n.x, 0) / nodes.length;
  const centerY = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;

  // Temperature: starts high, decays linearly (simulated annealing)
  const tempStart = Math.max(
    300,
    Math.sqrt((nodes.length * p.linkDistance * p.linkDistance) / 4),
  );

  for (let iter = 0; iter < p.iterations; iter++) {
    const temp = tempStart * (1 - iter / p.iterations);
    const damping = 0.9;

    // Reset forces
    for (const n of nodes) {
      n.vx = 0;
      n.vy = 0;
    }

    // 1. Center gravity
    for (const n of nodes) {
      n.vx += (centerX - n.x) * p.centerForce;
      n.vy += (centerY - n.y) * p.centerForce;
    }

    // 2. Node repulsion (all pairs)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;

        // Use node size to compute minimum distance
        const minDist = (a.width + b.width) / 2 + SPACING;
        const force = p.repelForce / (dist * dist);

        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;

        // Extra push if nodes overlap
        if (dist < minDist) {
          const overlap = (minDist - dist) * 0.5;
          const ox = (dx / dist) * overlap;
          const oy = (dy / dist) * overlap;
          a.vx -= ox;
          a.vy -= oy;
          b.vx += ox;
          b.vy += oy;
        }
      }
    }

    // 3. Edge attraction
    for (const edge of edges) {
      const a = nodes.find(n => n.id === edge.source);
      const b = nodes.find(n => n.id === edge.target);
      if (!a || !b) continue;

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const delta = (dist - p.linkDistance) * p.linkForce;

      const fx = (dx / dist) * delta;
      const fy = (dy / dist) * delta;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    // Apply velocity with temperature-based clamping
    for (const n of nodes) {
      const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy) || 1;
      const clampedSpeed = Math.min(speed, temp);
      n.x += (n.vx / speed) * clampedSpeed * damping;
      n.y += (n.vy / speed) * clampedSpeed * damping;
    }

    // Zone containment: clamp nodes to their zone bounds
    for (const n of nodes) {
      const zone = nodeZone.get(n.id);
      if (!zone) continue;
      const padding = 20;
      const headerHeight = 32;
      n.x = Math.max(zone.bounds.x + padding, Math.min(zone.bounds.x + zone.bounds.width - n.width - padding, n.x));
      n.y = Math.max(zone.bounds.y + headerHeight + padding, Math.min(zone.bounds.y + zone.bounds.height - n.height - padding, n.y));
    }
  }

  return nodes.map(n => ({
    id: n.id,
    x: snapToGrid(n.x),
    y: snapToGrid(n.y),
  }));
}

/**
 * Apply a layout pattern to a set of cards.
 */
export function computeLayout(
  pattern: 'horizontal' | 'vertical' | 'grid' | 'hub_spoke' | 'auto' | 'force' | 'elk',
  cards: CardInfo[],
  edges?: ForceEdge[],
  forceParams?: ForceLayoutParams,
  zones?: ForceZoneConstraint[],
): LayoutResult[] {
  switch (pattern) {
    case 'horizontal': return layoutHorizontal(cards);
    case 'vertical': return layoutVertical(cards);
    case 'grid': return layoutGrid(cards);
    case 'hub_spoke': return layoutHubSpoke(cards);
    case 'auto': return autoLayout(cards);
    case 'force': {
      // Force layout needs initial positions — use grid as starting point if not provided
      const initial = layoutGrid(cards);
      const cardsWithPos = cards.map((c, i) => ({
        ...c,
        x: initial[i]?.x ?? 100 + i * 340,
        y: initial[i]?.y ?? 100,
      }));
      return layoutForceDirected(cardsWithPos, edges || [], forceParams, zones);
    }
    case 'elk':
      // ELK is async — callers should use layoutElk() directly.
      // Sync fallback uses grid layout.
      return layoutGrid(cards);
    default: return layoutGrid(cards);
  }
}
