import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import { snapToGrid } from './canvas-layout';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ElkLayoutInput {
  cards: Array<{ id: string; width: number; height: number; zoneId?: string }>;
  edges: Array<{ id: string; source: string; target: string }>;
  zones: Array<{ id: string; width: number; height: number; childIds: string[] }>;
}

export interface ElkLayoutResult {
  nodes: Array<{ id: string; x: number; y: number }>;
  edges: Array<{ id: string; path: string }>;
}

// ---------------------------------------------------------------------------
// ELK options
// ---------------------------------------------------------------------------

const ELK_OPTIONS: Record<string, string> = {
  'elk.algorithm': 'elk.layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'SPLINES',
  'elk.portConstraints': 'FIXED_SIDE',
  // Spacing — generous gaps so edges are visually distinct
  'elk.spacing.nodeNode': '100',
  'elk.spacing.edgeEdge': '40',
  'elk.spacing.edgeNode': '50',
  'elk.spacing.componentComponent': '140',
  'elk.layered.spacing.nodeNodeBetweenLayers': '160',
  'elk.layered.spacing.edgeNodeBetweenLayers': '60',
  'elk.layered.spacing.edgeEdgeBetweenLayers': '35',
  // Quality — max effort for crossing reduction and placement
  'elk.layered.thoroughness': '10',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.nodePlacement.networkSimplex.nodeFlexibility.default': 'NODE_SIZE',
  'elk.layered.compaction.postCompaction.strategy': 'LEFT_RIGHT_DIRECTED',
  // Prefer long straight edges over short kinked ones
  'elk.layered.wrapping.strategy': 'OFF',
  'elk.layered.mergeEdges': 'false',
  // Components and padding
  'elk.separateConnectedComponents': 'true',
  'elk.padding': '[top=40,left=40,bottom=40,right=40]',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const { cards, edges, zones } = input;

  if (cards.length === 0 && zones.length === 0) {
    return { nodes: [], edges: [] };
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
      layoutOptions: { ...ELK_OPTIONS },
    });
  }

  // Standalone (non-zoned) cards.
  for (const card of cards) {
    if (!zoneChildIds.has(card.id)) {
      topChildren.push({ id: card.id, width: card.width, height: card.height });
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
    layoutOptions: { ...ELK_OPTIONS },
  };

  const elk = new ELK();
  const result = await elk.layout(graph);

  const nodes = flattenNodes(result).map((n) => ({
    id: n.id,
    x: snapToGrid(n.x),
    y: snapToGrid(n.y),
  }));

  const edgePaths = flattenEdges(result);

  return { nodes, edges: edgePaths };
}
