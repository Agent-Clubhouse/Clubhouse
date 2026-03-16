// ── Pure canvas operations — no side effects, fully testable ─────────

import type {
  CanvasView,
  CanvasViewType,
  AgentCanvasView,
  FileCanvasView,
  BrowserCanvasView,
  Position,
  Size,
  Viewport,
  CanvasInstance,
} from './canvas-types';
import {
  GRID_SIZE,
  MIN_VIEW_WIDTH,
  MIN_VIEW_HEIGHT,
  DEFAULT_VIEW_WIDTH,
  DEFAULT_VIEW_HEIGHT,
  MIN_ZOOM,
  MAX_ZOOM,
  CANVAS_SIZE,
} from './canvas-types';

// ── ID generation ────────────────────────────────────────────────────

export interface ViewCounter {
  value: number;
}

export function createViewCounter(initial = 0): ViewCounter {
  return { value: initial };
}

const defaultCounter: ViewCounter = { value: 0 };

export function generateViewId(counter: ViewCounter = defaultCounter): string {
  return `cv_${++counter.value}`;
}

export function resetViewCounter(value = 0, counter: ViewCounter = defaultCounter): void {
  counter.value = value;
}

/** Ensure counter is above any existing view ID to prevent collisions */
export function syncCounterToViews(views: CanvasView[], counter: ViewCounter = defaultCounter): void {
  const max = views.reduce((m, v) => {
    const match = v.id.match(/_(\d+)$/);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  if (max >= counter.value) {
    counter.value = max;
  }
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
  counter: ViewCounter = defaultCounter,
): CanvasView {
  const snappedPos = snapPosition(position);
  const base = {
    id: generateViewId(counter),
    position: snappedPos,
    size: { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT },
    zIndex: nextZIndex,
  };

  switch (type) {
    case 'agent':
      return { ...base, type: 'agent', title: 'Agent', agentId: null } satisfies AgentCanvasView;
    case 'file':
      return { ...base, type: 'file', title: 'Files' } satisfies FileCanvasView;
    case 'browser':
      return { ...base, type: 'browser', title: 'Browser', url: 'https://' } satisfies BrowserCanvasView;
  }
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
  return views.map((v) =>
    v.id === viewId
      ? { ...v, size: { width: Math.max(MIN_VIEW_WIDTH, size.width), height: Math.max(MIN_VIEW_HEIGHT, size.height) } }
      : v
  );
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
    x: Math.max(0, Math.min(CANVAS_SIZE, pos.x)),
    y: Math.max(0, Math.min(CANVAS_SIZE, pos.y)),
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

// ── Canvas instance helpers ──────────────────────────────────────────

export interface CanvasCounter {
  value: number;
}

export function createCanvasCounter(initial = 0): CanvasCounter {
  return { value: initial };
}

export function generateCanvasId(counter: CanvasCounter): string {
  return `canvas_${++counter.value}`;
}

export function syncCounterToInstances(instances: CanvasInstance[], counter: CanvasCounter): void {
  const max = instances.reduce((m, inst) => {
    const match = inst.id.match(/_(\d+)$/);
    return match ? Math.max(m, parseInt(match[1], 10)) : m;
  }, 0);
  if (max >= counter.value) {
    counter.value = max;
  }
}
