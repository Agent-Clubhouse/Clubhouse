// ── Pure canvas operations — no side effects, fully testable ─────────

import type {
  CanvasView,
  CanvasViewType,
  AgentCanvasView,
  AnchorCanvasView,
  PluginCanvasView,
  StickyNoteCanvasView,
  ZoneCanvasView,
  Position,
  Size,
  Viewport,
} from './canvas-types';
import {
  GRID_SIZE,
  MIN_VIEW_WIDTH,
  MIN_VIEW_HEIGHT,
  DEFAULT_VIEW_WIDTH,
  DEFAULT_VIEW_HEIGHT,
  DEFAULT_ANCHOR_WIDTH,
  DEFAULT_ANCHOR_HEIGHT,
  ANCHOR_HEIGHT,
  DEFAULT_STICKY_WIDTH,
  DEFAULT_STICKY_HEIGHT,
  DEFAULT_ZONE_WIDTH,
  DEFAULT_ZONE_HEIGHT,
  MIN_ZONE_WIDTH,
  MIN_ZONE_HEIGHT,
  ZONE_PADDING,
  ZONE_CARD_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  CANVAS_SIZE,
  deduplicateDisplayName,
} from './canvas-types';
import { generateZoneName } from '../../../../shared/name-generator';
import type { CanvasWidgetMetadata, CanvasWidgetFilter, CanvasWidgetHandle } from '../../../../shared/plugin-types';

// ── ID generation ────────────────────────────────────────────────────

/** Generate a stable, random view ID that won't be recycled across sessions. */
export function generateViewId(): string {
  return `cv_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// ── Grid snapping ────────────────────────────────────────────────────

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export function snapPosition(pos: Position): Position {
  return { x: snapToGrid(pos.x), y: snapToGrid(pos.y) };
}

export function snapSize(size: Size): Size {
  return {
    width: Math.max(MIN_VIEW_WIDTH, snapToGrid(size.width)),
    height: Math.max(MIN_VIEW_HEIGHT, snapToGrid(size.height)),
  };
}

// ── View CRUD ────────────────────────────────────────────────────────

export function createView(
  type: CanvasViewType,
  position: Position,
  nextZIndex: number,
  existingDisplayNames: string[] = [],
): CanvasView {
  const snappedPos = snapPosition(position);
  const base = {
    id: generateViewId(),
    position: snappedPos,
    size: { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT },
    zIndex: nextZIndex,
  };

  switch (type) {
    case 'agent': {
      const displayName = deduplicateDisplayName('Agent', existingDisplayNames);
      return { ...base, type: 'agent', title: 'Agent', displayName, metadata: {}, agentId: null } satisfies AgentCanvasView;
    }
    case 'anchor': {
      const displayName = deduplicateDisplayName('Anchor', existingDisplayNames);
      return {
        ...base,
        type: 'anchor',
        title: 'Anchor',
        displayName,
        metadata: {},
        label: displayName,
        size: { width: DEFAULT_ANCHOR_WIDTH, height: DEFAULT_ANCHOR_HEIGHT },
      } satisfies AnchorCanvasView;
    }
    case 'zone': {
      const displayName = deduplicateDisplayName(generateZoneName(), existingDisplayNames);
      return {
        ...base,
        type: 'zone',
        title: displayName,
        displayName,
        metadata: {},
        themeId: 'catppuccin-mocha',
        containedViewIds: [],
        size: { width: DEFAULT_ZONE_WIDTH, height: DEFAULT_ZONE_HEIGHT },
      } satisfies ZoneCanvasView;
    }
    case 'sticky-note': {
      const displayName = deduplicateDisplayName('Sticky Note', existingDisplayNames);
      return {
        ...base,
        type: 'sticky-note',
        title: 'Sticky Note',
        displayName,
        metadata: {},
        content: '',
        color: 'yellow',
        size: { width: DEFAULT_STICKY_WIDTH, height: DEFAULT_STICKY_HEIGHT },
      } satisfies StickyNoteCanvasView;
    }
    case 'plugin':
      // Plugin views are created via createPluginView instead
      throw new Error('Use createPluginView() for plugin widget types');
  }
}

export function createPluginView(
  pluginId: string,
  pluginWidgetType: string,
  label: string,
  position: Position,
  nextZIndex: number,
  existingDisplayNames: string[] = [],
  metadata: CanvasWidgetMetadata = {},
  defaultSize?: { width: number; height: number },
): PluginCanvasView {
  const snappedPos = snapPosition(position);
  const displayName = deduplicateDisplayName(label, existingDisplayNames);
  return {
    id: generateViewId(),
    type: 'plugin',
    position: snappedPos,
    size: defaultSize
      ? { width: Math.max(MIN_VIEW_WIDTH, defaultSize.width), height: Math.max(MIN_VIEW_HEIGHT, defaultSize.height) }
      : { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT },
    title: label,
    displayName,
    zIndex: nextZIndex,
    metadata,
    pluginWidgetType,
    pluginId,
  };
}

// ── Widget query ────────────────────────────────────────────────────────

export function queryViews(views: CanvasView[], filter?: CanvasWidgetFilter): CanvasWidgetHandle[] {
  if (!filter) {
    return views.map(viewToHandle);
  }

  return views.filter((v) => {
    if (filter.id && v.id !== filter.id) return false;
    if (filter.type) {
      const viewType = v.type === 'plugin' ? (v as PluginCanvasView).pluginWidgetType : v.type;
      if (viewType !== filter.type) return false;
    }
    if (filter.displayName) {
      if (!v.displayName.toLowerCase().includes(filter.displayName.toLowerCase())) return false;
    }
    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        if (value === null) {
          if (v.metadata[key] !== null && v.metadata[key] !== undefined) return false;
        } else {
          if (v.metadata[key] !== value) return false;
        }
      }
    }
    return true;
  }).map(viewToHandle);
}

function viewToHandle(v: CanvasView): CanvasWidgetHandle {
  return {
    id: v.id,
    type: v.type === 'plugin' ? (v as PluginCanvasView).pluginWidgetType : v.type,
    displayName: v.displayName,
    metadata: { ...v.metadata },
  };
}

export function removeView(views: CanvasView[], viewId: string): CanvasView[] {
  return views.filter((v) => v.id !== viewId);
}

export function updateViewPosition(views: CanvasView[], viewId: string, position: Position): CanvasView[] {
  return views.map((v) =>
    v.id === viewId ? { ...v, position: clampPosition(position) } : v
  );
}

export function updateViewSize(views: CanvasView[], viewId: string, size: Size): CanvasView[] {
  return views.map((v) => {
    if (v.id !== viewId) return v;
    // Anchors have a fixed height — only width is user-adjustable
    if (v.type === 'anchor') {
      return { ...v, size: { width: Math.max(MIN_VIEW_WIDTH, size.width), height: ANCHOR_HEIGHT } };
    }
    // Zones enforce their own minimums and cannot shrink below contained widget bounds
    if (v.type === 'zone') {
      const zone = v as ZoneCanvasView;
      const containedViews = views.filter((cv) => zone.containedViewIds.includes(cv.id));
      const minBounds = computeZoneBounds(zone, containedViews);
      return {
        ...v,
        size: {
          width: Math.max(MIN_ZONE_WIDTH, minBounds.size.width, size.width),
          height: Math.max(MIN_ZONE_HEIGHT, minBounds.size.height, size.height),
        },
      };
    }
    const height = Math.max(MIN_VIEW_HEIGHT, size.height);
    return { ...v, size: { width: Math.max(MIN_VIEW_WIDTH, size.width), height } };
  });
}

export function updateViewTitle(views: CanvasView[], viewId: string, title: string): CanvasView[] {
  return views.map((v) =>
    v.id === viewId ? { ...v, title } : v
  );
}

// ── Z-index / focus ──────────────────────────────────────────────────

export function bringToFront(views: CanvasView[], viewId: string, nextZIndex: number): { views: CanvasView[]; nextZIndex: number } {
  return {
    views: views.map((v) =>
      v.id === viewId ? { ...v, zIndex: nextZIndex } : v
    ),
    nextZIndex: nextZIndex + 1,
  };
}

// ── Viewport ─────────────────────────────────────────────────────────

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function clampPosition(pos: Position): Position {
  return {
    x: Math.max(-CANVAS_SIZE, Math.min(CANVAS_SIZE, pos.x)),
    y: Math.max(-CANVAS_SIZE, Math.min(CANVAS_SIZE, pos.y)),
  };
}

export function clampViewport(viewport: Viewport): Viewport {
  return {
    panX: viewport.panX,
    panY: viewport.panY,
    zoom: clampZoom(viewport.zoom),
  };
}

export function zoomTowardPoint(
  viewport: Viewport,
  targetZoom: number,
  clientX: number,
  clientY: number,
  containerRect: { left: number; top: number },
): Viewport {
  const clamped = clampZoom(targetZoom);
  const oldZoom = viewport.zoom;

  // Mouse position in virtual space before zoom
  const mouseXInCanvas = (clientX - containerRect.left) / oldZoom - viewport.panX;
  const mouseYInCanvas = (clientY - containerRect.top) / oldZoom - viewport.panY;

  // Adjust pan so the same virtual point stays under the cursor
  const newPanX = (clientX - containerRect.left) / clamped - mouseXInCanvas;
  const newPanY = (clientY - containerRect.top) / clamped - mouseYInCanvas;

  return { panX: newPanX, panY: newPanY, zoom: clamped };
}

// ── Viewport helpers ──────────────────────────────────────────────────

/** Compute the bounding box of all views. Returns null if no views. */
export function computeBoundingBox(views: CanvasView[]): { x: number; y: number; width: number; height: number } | null {
  if (views.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of views) {
    minX = Math.min(minX, v.position.x);
    minY = Math.min(minY, v.position.y);
    maxX = Math.max(maxX, v.position.x + v.size.width);
    maxY = Math.max(maxY, v.position.y + v.size.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Return a viewport that fits all views with padding inside the given container size. */
export function viewportToFitViews(
  views: CanvasView[],
  containerWidth: number,
  containerHeight: number,
  padding = 60,
): Viewport {
  const bbox = computeBoundingBox(views);
  if (!bbox) return { panX: 0, panY: 0, zoom: 1 };

  const availW = containerWidth - padding * 2;
  const availH = containerHeight - padding * 2;
  const scaleX = availW / bbox.width;
  const scaleY = availH / bbox.height;
  const zoom = clampZoom(Math.min(scaleX, scaleY, 1)); // don't zoom above 1

  const centerX = bbox.x + bbox.width / 2;
  const centerY = bbox.y + bbox.height / 2;
  const panX = (containerWidth / 2) / zoom - centerX;
  const panY = (containerHeight / 2) / zoom - centerY;

  return { panX, panY, zoom };
}

/** Return a viewport centered on a specific view. */
export function viewportToCenterView(
  view: CanvasView,
  containerWidth: number,
  containerHeight: number,
  zoom: number,
): Viewport {
  const centerX = view.position.x + view.size.width / 2;
  const centerY = view.position.y + view.size.height / 2;
  const panX = (containerWidth / 2) / zoom - centerX;
  const panY = (containerHeight / 2) / zoom - centerY;
  return { panX, panY, zoom };
}

// ── Overlap detection & reflow ───────────────────────────────────────

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function viewToRect(v: CanvasView): Rect {
  return { x: v.position.x, y: v.position.y, width: v.size.width, height: v.size.height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x &&
         a.y < b.y + b.height && a.y + a.height > b.y;
}

export function detectOverlaps(views: CanvasView[], viewId: string): CanvasView[] {
  const target = views.find((v) => v.id === viewId);
  if (!target) return [];
  const targetRect = viewToRect(target);
  return views.filter((v) => v.id !== viewId && rectsOverlap(targetRect, viewToRect(v)));
}

export function reflowViews(
  views: CanvasView[],
  droppedViewId: string,
  direction: 'right' | 'down' = 'right',
): CanvasView[] {
  const dropped = views.find((v) => v.id === droppedViewId);
  if (!dropped) return views;

  const overlapping = detectOverlaps(views, droppedViewId);
  if (overlapping.length === 0) return views;

  const overlapIds = new Set(overlapping.map((v) => v.id));
  return views.map((v) => {
    if (!overlapIds.has(v.id)) return v;
    if (direction === 'right') {
      return { ...v, position: snapPosition({ x: dropped.position.x + dropped.size.width + GRID_SIZE, y: v.position.y }) };
    }
    return { ...v, position: snapPosition({ x: v.position.x, y: dropped.position.y + dropped.size.height + GRID_SIZE }) };
  });
}

// ── Coordinate conversion ────────────────────────────────────────────

/**
 * Convert screen (viewport) coordinates to canvas-space coordinates.
 * The canvas transform is: scale(zoom) translate(panX, panY) with transformOrigin 0 0.
 * Visual position of canvas point (cx,cy) = ((cx + panX) * zoom, (cy + panY) * zoom).
 * Inverse: cx = (screenX - containerLeft) / zoom - panX
 */
export function screenToCanvas(
  clientX: number,
  clientY: number,
  containerRect: { left: number; top: number },
  viewport: Viewport,
): Position {
  return {
    x: (clientX - containerRect.left) / viewport.zoom - viewport.panX,
    y: (clientY - containerRect.top) / viewport.zoom - viewport.panY,
  };
}

/**
 * Convert canvas-space coordinates to screen (viewport) coordinates.
 * Inverse of screenToCanvas.
 */
export function canvasToScreen(
  canvasX: number,
  canvasY: number,
  containerRect: { left: number; top: number },
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: (canvasX + viewport.panX) * viewport.zoom + containerRect.left,
    y: (canvasY + viewport.panY) * viewport.zoom + containerRect.top,
  };
}

// ── Multi-select helpers ─────────────────────────────────────────────

/**
 * Check whether a view is fully contained within the given rectangle.
 * Both the view and the rect are in canvas-space coordinates.
 */
export function isViewFullyInRect(
  view: CanvasView,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  // Normalise rect so width/height are positive (drag can go any direction)
  const rx = rect.width >= 0 ? rect.x : rect.x + rect.width;
  const ry = rect.height >= 0 ? rect.y : rect.y + rect.height;
  const rw = Math.abs(rect.width);
  const rh = Math.abs(rect.height);

  return (
    view.position.x >= rx &&
    view.position.y >= ry &&
    view.position.x + view.size.width <= rx + rw &&
    view.position.y + view.size.height <= ry + rh
  );
}

/**
 * Compute tiled positions for a set of views dropped at an origin point.
 * Arranges views in a grid (columns = ceil(sqrt(N))), snapped to grid,
 * with a configurable gap between them.
 */
export function computeTiledPositions(
  views: CanvasView[],
  origin: Position,
  gap: number = GRID_SIZE,
): Map<string, Position> {
  if (views.length === 0) return new Map();
  if (views.length === 1) {
    return new Map([[views[0].id, snapPosition(origin)]]);
  }

  const cols = Math.ceil(Math.sqrt(views.length));
  const result = new Map<string, Position>();

  // Pre-compute max width per column and max height per row for neat alignment
  const colWidths: number[] = new Array(cols).fill(0);
  const rowCount = Math.ceil(views.length / cols);
  const rowHeights: number[] = new Array(rowCount).fill(0);

  for (let i = 0; i < views.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    colWidths[col] = Math.max(colWidths[col], views[i].size.width);
    rowHeights[row] = Math.max(rowHeights[row], views[i].size.height);
  }

  // Compute cumulative offsets
  const colOffsets: number[] = [0];
  for (let c = 1; c < cols; c++) {
    colOffsets[c] = colOffsets[c - 1] + colWidths[c - 1] + gap;
  }
  const rowOffsets: number[] = [0];
  for (let r = 1; r < rowCount; r++) {
    rowOffsets[r] = rowOffsets[r - 1] + rowHeights[r - 1] + gap;
  }

  for (let i = 0; i < views.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    result.set(views[i].id, snapPosition({
      x: origin.x + colOffsets[col],
      y: origin.y + rowOffsets[row],
    }));
  }

  return result;
}

// ── Zone containment ────────────────────────────────────────────────

/** Check if a view is spatially inside a zone (>50% overlap by area). */
export function isViewInZone(view: CanvasView, zone: ZoneCanvasView): boolean {
  if (view.id === zone.id) return false;
  if (view.type === 'zone') return false; // no nesting

  const overlapX = Math.max(0,
    Math.min(view.position.x + view.size.width, zone.position.x + zone.size.width)
    - Math.max(view.position.x, zone.position.x),
  );
  const overlapY = Math.max(0,
    Math.min(view.position.y + view.size.height, zone.position.y + zone.size.height)
    - Math.max(view.position.y, zone.position.y),
  );
  const overlapArea = overlapX * overlapY;
  const viewArea = view.size.width * view.size.height;
  return viewArea > 0 && overlapArea > viewArea * 0.5;
}

/** Compute which non-zone views are contained in a zone. */
export function computeZoneContainment(zone: ZoneCanvasView, allViews: CanvasView[]): string[] {
  return allViews
    .filter((v) => isViewInZone(v, zone))
    .map((v) => v.id);
}

/** Compute the minimum bounds a zone needs to encompass all contained views plus padding. */
export function computeZoneBounds(
  zone: ZoneCanvasView,
  containedViews: CanvasView[],
  padding: number = ZONE_PADDING,
): { position: Position; size: Size } {
  if (containedViews.length === 0) {
    return { position: zone.position, size: zone.size };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of containedViews) {
    minX = Math.min(minX, v.position.x);
    minY = Math.min(minY, v.position.y);
    maxX = Math.max(maxX, v.position.x + v.size.width);
    maxY = Math.max(maxY, v.position.y + v.size.height);
  }

  // Account for zone card at top-left
  const topPadding = Math.max(padding, ZONE_CARD_HEIGHT + 10);

  return {
    position: snapPosition({ x: minX - padding, y: minY - topPadding }),
    size: {
      width: Math.max(MIN_ZONE_WIDTH, snapToGrid(maxX - minX + padding * 2)),
      height: Math.max(MIN_ZONE_HEIGHT, snapToGrid(maxY - minY + topPadding + padding)),
    },
  };
}

/**
 * Recompute containment and auto-resize for all zones after spatial changes.
 * Returns updated views array.
 */
export function recomputeZones(views: CanvasView[]): CanvasView[] {
  const zones = views.filter((v): v is ZoneCanvasView => v.type === 'zone');
  if (zones.length === 0) return views;

  let updated = [...views];
  for (const zone of zones) {
    const containedIds = computeZoneContainment(zone, updated);
    const containedViews = updated.filter((v) => containedIds.includes(v.id));
    const { position, size } = computeZoneBounds(zone, containedViews);

    updated = updated.map((v) =>
      v.id === zone.id
        ? { ...v, containedViewIds: containedIds, position, size } as ZoneCanvasView
        : v,
    );
  }

  return updated;
}

// ── Canvas instance helpers ──────────────────────────────────────────

/** Generate a stable, random canvas instance ID. */
export function generateCanvasId(): string {
  return `canvas_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;
}
