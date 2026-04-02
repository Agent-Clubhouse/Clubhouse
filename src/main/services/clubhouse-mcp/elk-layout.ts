import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import { snapToGrid } from './canvas-layout';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ElkAlgorithm = 'layered' | 'radial' | 'force' | 'mrtree';
export type LayeredDirection = 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';

export interface ElkLayoutOptions {
  algorithm: ElkAlgorithm;
  /** Flow direction for layered algorithm. Default: 'RIGHT'. */
  direction?: LayeredDirection;
  /** Root node ID for radial algorithm. If omitted, auto-picks the most-connected node. */
  rootId?: string;
  /** Preferred center card ID set via "Set as Layout Center" context menu. */
  layoutCenterId?: string;
}

export interface ElkLayoutInput {
  cards: Array<{ id: string; width: number; height: number; zoneId?: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
  zones: Array<{ id: string; width: number; height: number; childIds: string[] }>;
  options?: ElkLayoutOptions;
}

export interface ElkLayoutResult {
  nodes: Array<{ id: string; x: number; y: number }>;
  edges: Array<{ id: string; path: string }>;
}

// ---------------------------------------------------------------------------
// Algorithm-specific ELK option sets
// ---------------------------------------------------------------------------

const SHARED_OPTIONS: Record<string, string> = {
  'elk.separateConnectedComponents': 'true',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
};

const LAYERED_OPTIONS: Record<string, string> = {
  ...SHARED_OPTIONS,
  'elk.algorithm': 'elk.layered',
  'elk.edgeRouting': 'SPLINES',
  'elk.portConstraints': 'FIXED_SIDE',
  // Spacing
  'elk.spacing.nodeNode': '100',
  'elk.spacing.edgeEdge': '40',
  'elk.spacing.edgeNode': '50',
  'elk.spacing.componentComponent': '140',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.layered.spacing.edgeNodeBetweenLayers': '60',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '35',
  // Quality
  'elk.layered.thoroughness': '10',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.networkSimplex.nodeFlexibility.default': 'NODE_SIZE',
  'elk.layered.compaction.postCompaction.strategy': 'LEFT_RIGHT_DIRECTED',
  'elk.layered.wrapping.strategy': 'OFF',
  'elk.layered.mergeEdges': 'false',
};

const RADIAL_OPTIONS: Record<string, string> = {
  ...SHARED_OPTIONS,
  'elk.algorithm': 'elk.radial',
  'elk.spacing.nodeNode': '120',
  'elk.spacing.componentComponent': '140',
  'elk.radial.compactor': 'WEDGE_COMPACTION',
  'elk.radial.centerOnRoot': 'true',
  'elk.radial.orderId': 'true',
  // Ensure radial rings have enough room for large cards
  'elk.radial.radius': '0',
};

const FORCE_OPTIONS: Record<string, string> = {
  ...SHARED_OPTIONS,
  'elk.algorithm': 'elk.force',
  'elk.spacing.nodeNode': '100',
  'elk.force.temperature': '0.001',
  'elk.force.iterations': '300',
  'elk.force.repulsion': '20.0',
};

const MRTREE_OPTIONS: Record<string, string> = {
  ...SHARED_OPTIONS,
  'elk.algorithm': 'elk.mrtree',
  'elk.spacing.nodeNode': '60',
  'elk.mrtree.weighting': 'CONSTRAINT',
  'elk.mrtree.searchOrder': 'DFS',
};

function getElkOptions(opts?: ElkLayoutOptions): Record<string, string> {
  const algorithm = opts?.algorithm ?? 'layered';
  switch (algorithm) {
    case 'layered': {
      const direction = opts?.direction ?? 'RIGHT';
      return { ...LAYERED_OPTIONS, 'elk.direction': direction };
    }
    case 'radial':
      return { ...RADIAL_OPTIONS };
    case 'force':
      return { ...FORCE_OPTIONS };
    case 'mrtree': {
      const direction = opts?.direction ?? 'DOWN';
      return { ...MRTREE_OPTIONS, 'elk.direction': direction };
    }
    default:
      return { ...LAYERED_OPTIONS, 'elk.direction': 'RIGHT' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Auto-pick the most-connected node as the root for radial layout.
 * If `gpHubIds` is provided, prefer those as the root (GP hub cards
 * are natural centers for hub-spoke topologies).
 * @internal Exported for testing.
 */
export function pickRootNode(
  cards: Array<{ id: string }>,
  edges: Array<{ source: string; target: string }>,
  gpHubIds?: string[],
): string | undefined {
  if (cards.length === 0) return undefined;
  const degree = new Map<string, number>();
  for (const card of cards) degree.set(card.id, 0);
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  // Prefer GP hub card if present and has connections
  if (gpHubIds && gpHubIds.length > 0) {
    let bestHub: string | undefined;
    let bestHubDeg = -1;
    for (const hubId of gpHubIds) {
      const deg = degree.get(hubId) ?? 0;
      if (deg > bestHubDeg) {
        bestHubDeg = deg;
        bestHub = hubId;
      }
    }
    if (bestHub && bestHubDeg > 0) return bestHub;
  }

  let maxId = cards[0].id;
  let maxDeg = 0;
  for (const [id, deg] of degree) {
    if (deg > maxDeg) {
      maxDeg = deg;
      maxId = id;
    }
  }
  return maxId;
}

/**
 * Resolve overlapping nodes after ELK layout.
 * Pushes overlapping cards apart along the vector from the center
 * of the layout to the card, preserving radial structure.
 */
export function resolveOverlaps(
  nodes: Array<{ id: string; x: number; y: number }>,
  cardSizes: Map<string, { width: number; height: number }>,
  padding = 20,
  maxIterations = 10,
): Array<{ id: string; x: number; y: number }> {
  // Work with mutable copies
  const positions = nodes.map(n => ({ ...n }));
  if (positions.length <= 1) return positions;

  for (let iter = 0; iter < maxIterations; iter++) {
    let hadOverlap = false;

    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i];
        const b = positions[j];
        const sizeA = cardSizes.get(a.id) ?? { width: 300, height: 200 };
        const sizeB = cardSizes.get(b.id) ?? { width: 300, height: 200 };

        // Check AABB overlap with padding
        const overlapX = (sizeA.width / 2 + sizeB.width / 2 + padding) -
          Math.abs((a.x + sizeA.width / 2) - (b.x + sizeB.width / 2));
        const overlapY = (sizeA.height / 2 + sizeB.height / 2 + padding) -
          Math.abs((a.y + sizeA.height / 2) - (b.y + sizeB.height / 2));

        if (overlapX > 0 && overlapY > 0) {
          hadOverlap = true;

          // Push apart along the axis of least overlap
          const centerAx = a.x + sizeA.width / 2;
          const centerAy = a.y + sizeA.height / 2;
          const centerBx = b.x + sizeB.width / 2;
          const centerBy = b.y + sizeB.height / 2;

          let dx = centerBx - centerAx;
          let dy = centerBy - centerAy;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 1) {
            // Cards are at nearly the same position — push apart arbitrarily
            dx = 1;
            dy = 0;
          } else {
            dx /= dist;
            dy /= dist;
          }

          // Use the smaller overlap to determine push distance
          const push = Math.min(overlapX, overlapY) / 2 + 1;
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
    }

    if (!hadOverlap) break;
  }

  return positions;
}

/** Convert ELK edge sections (start, bends, end) into an SVG cubic-bezier path. */
function sectionsToSvgPath(sections: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: Array<{ x: number; y: number }> }[]): string {
  if (!sections || sections.length === 0) return '';

  const parts: string[] = [];
  for (const section of sections) {
    const { startPoint, endPoint, bendPoints } = section;
    parts.push(`M ${startPoint.x} ${startPoint.y}`);

    if (!bendPoints || bendPoints.length === 0) {
      parts.push(`L ${endPoint.x} ${endPoint.y}`);
    } else {
      // Build cubic bezier segments.  ELK splines give us intermediate bend
      // points — group them into triples for C commands.  If the count isn't
      // a multiple of 3 we pad the last segment by repeating the final bend
      // point so we always emit valid cubic curves.
      const pts = [...bendPoints, endPoint];
      let i = 0;
      while (i < pts.length) {
        const p1 = pts[i];
        const p2 = pts[i + 1] ?? pts[pts.length - 1];
        const p3 = pts[i + 2] ?? pts[pts.length - 1];
        parts.push(`C ${p1.x} ${p1.y} ${p2.x} ${p2.y} ${p3.x} ${p3.y}`);
        i += 3;
      }
    }
  }
  return parts.join(' ');
}

/** Collect positioned nodes from a (possibly nested) ELK result. */
function flattenNodes(
  elkNode: ElkNode,
  offsetX = 0,
  offsetY = 0,
): Array<{ id: string; x: number; y: number }> {
  const results: Array<{ id: string; x: number; y: number }> = [];
  for (const child of elkNode.children ?? []) {
    const absX = offsetX + (child.x ?? 0);
    const absY = offsetY + (child.y ?? 0);

    if (child.children && child.children.length > 0) {
      // Compound (zone) node — recurse into children, don't emit the zone itself.
      results.push(...flattenNodes(child, absX, absY));
    } else {
      results.push({ id: child.id, x: absX, y: absY });
    }
  }
  return results;
}

/** Collect edge paths from an ELK result (including nested edges). */
function flattenEdges(
  elkNode: ElkNode,
  offsetX = 0,
  offsetY = 0,
): Array<{ id: string; path: string }> {
  const results: Array<{ id: string; path: string }> = [];

  for (const edge of (elkNode.edges ?? []) as ElkExtendedEdge[]) {
    const sections = edge.sections ?? [];
    // Offset sections by parent position.
    const shifted = sections.map((s) => ({
      startPoint: { x: s.startPoint.x + offsetX, y: s.startPoint.y + offsetY },
      endPoint: { x: s.endPoint.x + offsetX, y: s.endPoint.y + offsetY },
      bendPoints: s.bendPoints?.map((bp) => ({ x: bp.x + offsetX, y: bp.y + offsetY })),
    }));
    const path = sectionsToSvgPath(shifted);
    if (path) {
      results.push({ id: edge.id, path });
    }
  }

  for (const child of elkNode.children ?? []) {
    const absX = offsetX + (child.x ?? 0);
    const absY = offsetY + (child.y ?? 0);
    results.push(...flattenEdges(child, absX, absY));
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function layoutElk(input: ElkLayoutInput): Promise<ElkLayoutResult> {
  const { cards, edges, zones, options } = input;

  if (cards.length === 0 && zones.length === 0) {
    return { nodes: [], edges: [] };
  }

  const elkOptions = getElkOptions(options);

  // For radial layout, dynamically adjust spacing based on card dimensions
  if (options?.algorithm === 'radial' && cards.length > 0) {
    const maxWidth = Math.max(...cards.map(c => c.width));
    const maxHeight = Math.max(...cards.map(c => c.height));
    const maxDimension = Math.max(maxWidth, maxHeight);
    // Ensure nodeNode spacing is at least as large as the biggest card + padding
    const dynamicSpacing = Math.max(120, maxDimension + 40);
    elkOptions['elk.spacing.nodeNode'] = String(dynamicSpacing);
  }

  // For radial layout, determine root node:
  // Priority: explicit rootId (selected card) > layoutCenterId (stored) > auto-detect
  let rootId: string | undefined;
  if (options?.algorithm === 'radial') {
    rootId = options.rootId
      ?? options.layoutCenterId
      ?? pickRootNode(cards, edges);
  }

  // Build a set of card ids that belong to a zone for quick lookup.
  const zoneChildIds = new Set(zones.flatMap((z) => z.childIds));

  // Top-level ELK children: zones (compound) + standalone cards.
  const topChildren: ElkNode[] = [];

  // Zone compound nodes.
  for (const zone of zones) {
    const zoneChildren: ElkNode[] = zone.childIds
      .map((cid) => cards.find((c) => c.id === cid))
      .filter(Boolean)
      .map((c) => ({ id: c!.id, width: c!.width, height: c!.height }));

    topChildren.push({
      id: zone.id,
      width: zone.width,
      height: zone.height,
      children: zoneChildren,
      layoutOptions: { ...elkOptions },
    });
  }

  // Standalone (non-zoned) cards.
  for (const card of cards) {
    if (!zoneChildIds.has(card.id)) {
      const nodeProps: ElkNode = { id: card.id, width: card.width, height: card.height };
      // Mark the root node for radial layout
      if (rootId && card.id === rootId) {
        nodeProps.layoutOptions = { 'elk.radial.centerOnRoot': 'true' };
      }
      topChildren.push(nodeProps);
    }
  }

  // ELK edges.
  const elkEdges: ElkExtendedEdge[] = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const graph: ElkNode = {
    id: 'root',
    children: topChildren,
    edges: elkEdges,
    layoutOptions: { ...elkOptions },
  };

  const elk = new ELK();
  const result = await elk.layout(graph);

  let nodes = flattenNodes(result).map((n) => ({
    id: n.id,
    x: snapToGrid(n.x),
    y: snapToGrid(n.y),
  }));

  // For radial layout, resolve any remaining overlaps caused by
  // ELK not fully accounting for variable card dimensions
  if (options?.algorithm === 'radial') {
    const cardSizes = new Map(cards.map(c => [c.id, { width: c.width, height: c.height }]));
    nodes = resolveOverlaps(nodes, cardSizes).map(n => ({
      id: n.id,
      x: snapToGrid(n.x),
      y: snapToGrid(n.y),
    }));
  }

  const edgePaths = flattenEdges(result);

  return { nodes, edges: edgePaths };
}
