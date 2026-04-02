// ── Hub-to-Canvas conversion — pure functions, no side effects ───────
//
// Flattens a hub pane tree into a set of positioned canvas agent views.
// The algorithm recursively walks the binary split tree, computing each
// leaf's absolute position and size from the split ratios and a reference
// frame (the current window dimensions).

import type { PaneNode } from './pane-tree';
import type { HubInstance } from './useHubStore';
import type { AgentCanvasView, CanvasInstance, Position, Size } from '../canvas/canvas-types';
import { GRID_SIZE, deduplicateDisplayName } from '../canvas/canvas-types';
import { generateViewId, generateCanvasId, snapToGrid, viewportToFitViews } from '../canvas/canvas-operations';

// ── Types ─────────────────────────────────────────────────────────────

export interface FlattenedPane {
  agentId: string | null;
  projectId?: string;
  position: Position;
  size: Size;
}

export interface ConvertHubOptions {
  /** Hub name — used to derive the canvas name. */
  hubName: string;
  /** The hub's pane tree to convert. */
  paneTree: PaneNode;
  /** Reference frame width (typically current window/container width). */
  referenceWidth: number;
  /** Reference frame height (typically current window/container height). */
  referenceHeight: number;
  /** Whether the original hub should be deleted (affects naming). */
  deleteOriginal: boolean;
  /** Container width for computing the initial viewport fit. */
  containerWidth: number;
  /** Container height for computing the initial viewport fit. */
  containerHeight: number;
}

// ── Gutter constant ───────────────────────────────────────────────────

const GUTTER = GRID_SIZE; // 20px

// ── Core flattening algorithm ─────────────────────────────────────────

/**
 * Recursively flatten the pane tree into leaf positions and sizes.
 * Each split divides the available rect by its ratio and direction,
 * subtracting gutter space between the two children.
 */
export function flattenPaneTree(
  node: PaneNode,
  x: number,
  y: number,
  width: number,
  height: number,
): FlattenedPane[] {
  if (node.type === 'leaf') {
    return [{
      agentId: node.agentId,
      projectId: node.projectId,
      position: { x: snapToGrid(x), y: snapToGrid(y) },
      size: {
        width: Math.max(200, snapToGrid(width)),
        height: Math.max(150, snapToGrid(height)),
      },
    }];
  }

  const ratio = node.ratio ?? 0.5;

  if (node.direction === 'horizontal') {
    // Split left/right
    const leftWidth = (width - GUTTER) * ratio;
    const rightWidth = width - GUTTER - leftWidth;
    const rightX = x + leftWidth + GUTTER;
    return [
      ...flattenPaneTree(node.children[0], x, y, leftWidth, height),
      ...flattenPaneTree(node.children[1], rightX, y, rightWidth, height),
    ];
  } else {
    // Split top/bottom (vertical direction)
    const topHeight = (height - GUTTER) * ratio;
    const bottomHeight = height - GUTTER - topHeight;
    const bottomY = y + topHeight + GUTTER;
    return [
      ...flattenPaneTree(node.children[0], x, y, width, topHeight),
      ...flattenPaneTree(node.children[1], x, bottomY, width, bottomHeight),
    ];
  }
}

// ── Canvas view builder ───────────────────────────────────────────────

/**
 * Convert flattened panes into canvas agent views centered at the origin.
 * The bounding box of all views is shifted so its center sits at (0,0).
 */
export function buildCanvasViews(panes: FlattenedPane[]): AgentCanvasView[] {
  if (panes.length === 0) return [];

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of panes) {
    minX = Math.min(minX, p.position.x);
    minY = Math.min(minY, p.position.y);
    maxX = Math.max(maxX, p.position.x + p.size.width);
    maxY = Math.max(maxY, p.position.y + p.size.height);
  }

  // Shift so the bounding box center is at (0, 0)
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const existingNames: string[] = [];

  return panes.map((p, i): AgentCanvasView => {
    const displayName = deduplicateDisplayName('Agent', existingNames);
    existingNames.push(displayName);

    return {
      id: generateViewId(),
      type: 'agent',
      position: {
        x: snapToGrid(p.position.x - centerX),
        y: snapToGrid(p.position.y - centerY),
      },
      size: p.size,
      title: 'Agent',
      displayName,
      zIndex: i,
      metadata: {},
      agentId: p.agentId,
      projectId: p.projectId,
    };
  });
}

// ── Full conversion ───────────────────────────────────────────────────

/**
 * Convert a hub into a complete CanvasInstance ready to be inserted
 * into the canvas store.
 */
export function convertHubToCanvas(options: ConvertHubOptions): CanvasInstance {
  const {
    hubName,
    paneTree,
    referenceWidth,
    referenceHeight,
    deleteOriginal,
    containerWidth,
    containerHeight,
  } = options;

  // Flatten pane tree into positioned rects
  const flattened = flattenPaneTree(paneTree, 0, 0, referenceWidth, referenceHeight);

  // Build canvas views centered at origin
  const views = buildCanvasViews(flattened);

  // Compute viewport that fits all views
  const viewport = viewportToFitViews(views, containerWidth, containerHeight);

  // Canvas name: no suffix if deleting original, "-upgraded" otherwise
  const canvasName = deleteOriginal ? hubName : `${hubName}-upgraded`;

  return {
    id: generateCanvasId(),
    name: canvasName,
    views,
    viewport,
    nextZIndex: views.length,
    zoomedViewId: null,
    selectedViewId: null,
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
  };
}

// ── Bulk migration ───────────────────────────────────────────────────

export interface ScopedHubs {
  /** App-level hubs (cross-project). */
  app: HubInstance[];
  /** Per-project hubs keyed by project ID. */
  projects: Map<string, HubInstance[]>;
}

export interface ScopedCanvases {
  /** Canvases converted from app-level hubs. */
  app: CanvasInstance[];
  /** Per-project canvases keyed by project ID. */
  projects: Map<string, CanvasInstance[]>;
}

/**
 * Convert all hubs (app + per-project) into canvas instances.
 * Pure function — caller is responsible for inserting them and disabling hub.
 */
export function convertAllHubsToCanvases(
  hubs: ScopedHubs,
  referenceWidth: number,
  referenceHeight: number,
): ScopedCanvases {
  const convert = (hubList: HubInstance[]): CanvasInstance[] =>
    hubList.map((hub) =>
      convertHubToCanvas({
        hubName: hub.name,
        paneTree: hub.paneTree,
        referenceWidth,
        referenceHeight,
        // Use true so the canvas inherits the original hub name (no "-upgraded" suffix).
        // The original hubs are preserved in storage; only the hub plugin is disabled.
        deleteOriginal: true,
        containerWidth: referenceWidth,
        containerHeight: referenceHeight,
      }),
    );

  const appCanvases = convert(hubs.app);
  const projectCanvases = new Map<string, CanvasInstance[]>();
  for (const [projectId, projectHubs] of hubs.projects) {
    projectCanvases.set(projectId, convert(projectHubs));
  }

  return { app: appCanvases, projects: projectCanvases };
}

// ── Hub duplication helpers ───────────────────────────────────────────

/**
 * Generate a deduplicated hub name with numeric suffix.
 * Given "My Hub" and existing names ["My Hub", "My Hub-2"], returns "My Hub-3".
 */
export function generateDuplicateHubName(baseName: string, existingNames: string[]): string {
  let suffix = 2;
  let candidate = `${baseName}-${suffix}`;
  while (existingNames.includes(candidate)) {
    suffix++;
    candidate = `${baseName}-${suffix}`;
  }
  return candidate;
}

/**
 * Deep-clone a pane tree, assigning fresh IDs to every node.
 * Agent assignments are preserved.
 */
export function clonePaneTree(
  node: PaneNode,
  idGenerator: () => string,
): PaneNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      id: idGenerator(),
      agentId: node.agentId,
      projectId: node.projectId,
    };
  }

  return {
    type: 'split',
    id: idGenerator(),
    direction: node.direction,
    ratio: node.ratio,
    children: [
      clonePaneTree(node.children[0], idGenerator),
      clonePaneTree(node.children[1], idGenerator),
    ] as [PaneNode, PaneNode],
  };
}
