import { describe, it, expect, beforeEach } from 'vitest';
import {
  createViewCounter,
  generateViewId,
  resetViewCounter,
  syncCounterToViews,
  snapToGrid,
  snapPosition,
  snapSize,
  createView,
  removeView,
  updateViewPosition,
  updateViewSize,
  updateViewTitle,
  bringToFront,
  clampZoom,
  clampPosition,
  clampViewport,
  zoomTowardPoint,
  computeBoundingBox,
  viewportToFitViews,
  viewportToCenterView,
  detectOverlaps,
  reflowViews,
  createCanvasCounter,
  generateCanvasId,
  syncCounterToInstances,
} from './canvas-operations';
import type { CanvasView, AgentCanvasView } from './canvas-types';
import { GRID_SIZE, MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT, MIN_ZOOM, MAX_ZOOM, CANVAS_SIZE } from './canvas-types';

describe('canvas-operations', () => {
  // ── ID generation ──────────────────────────────────────────────────

  describe('generateViewId', () => {
    it('generates sequential IDs with a scoped counter', () => {
      const counter = createViewCounter(0);
      expect(generateViewId(counter)).toBe('cv_1');
      expect(generateViewId(counter)).toBe('cv_2');
      expect(generateViewId(counter)).toBe('cv_3');
    });

    it('resets counter', () => {
      const counter = createViewCounter(10);
      resetViewCounter(0, counter);
      expect(generateViewId(counter)).toBe('cv_1');
    });
  });

  describe('syncCounterToViews', () => {
    it('syncs counter to highest existing view ID', () => {
      const counter = createViewCounter(0);
      const views: CanvasView[] = [
        { id: 'cv_5', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_10', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      syncCounterToViews(views, counter);
      expect(counter.value).toBe(10);
      expect(generateViewId(counter)).toBe('cv_11');
    });

    it('does not decrease counter', () => {
      const counter = createViewCounter(20);
      syncCounterToViews([{ id: 'cv_5', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null }], counter);
      expect(counter.value).toBe(20);
    });
  });

  // ── Grid snapping ──────────────────────────────────────────────────

  describe('snapToGrid', () => {
    it('snaps to nearest grid line', () => {
      expect(snapToGrid(0)).toBe(0);
      expect(snapToGrid(10)).toBe(GRID_SIZE);
      expect(snapToGrid(9)).toBe(0);
      expect(snapToGrid(30)).toBe(40); // 30/20 = 1.5, rounds to 2*20 = 40
      expect(snapToGrid(25)).toBe(20);
      expect(snapToGrid(35)).toBe(40);
    });
  });

  describe('snapPosition', () => {
    it('snaps both coordinates', () => {
      expect(snapPosition({ x: 13, y: 27 })).toEqual({ x: 20, y: 20 });
    });
  });

  describe('snapSize', () => {
    it('enforces minimum dimensions', () => {
      const result = snapSize({ width: 50, height: 50 });
      expect(result.width).toBeGreaterThanOrEqual(MIN_VIEW_WIDTH);
      expect(result.height).toBeGreaterThanOrEqual(MIN_VIEW_HEIGHT);
    });

    it('snaps to grid', () => {
      const result = snapSize({ width: 213, height: 317 });
      expect(result.width % GRID_SIZE).toBe(0);
      expect(result.height % GRID_SIZE).toBe(0);
    });
  });

  // ── View CRUD ──────────────────────────────────────────────────────

  describe('createView', () => {
    let counter: ReturnType<typeof createViewCounter>;

    beforeEach(() => {
      counter = createViewCounter(0);
    });

    it('creates an agent view', () => {
      const view = createView('agent', { x: 100, y: 200 }, 0, counter);
      expect(view.type).toBe('agent');
      expect(view.position).toEqual({ x: 100, y: 200 });
      expect((view as AgentCanvasView).agentId).toBeNull();
      expect(view.id).toBe('cv_1');
    });

    it('creates a file view', () => {
      const view = createView('file', { x: 0, y: 0 }, 1, counter);
      expect(view.type).toBe('file');
      expect(view.title).toBe('Files');
    });

    it('creates a browser view', () => {
      const view = createView('browser', { x: 0, y: 0 }, 2, counter);
      expect(view.type).toBe('browser');
      expect((view as any).url).toBe('https://');
    });

    it('snaps position to grid', () => {
      const view = createView('agent', { x: 13, y: 27 }, 0, counter);
      expect(view.position.x % GRID_SIZE).toBe(0);
      expect(view.position.y % GRID_SIZE).toBe(0);
    });
  });

  describe('removeView', () => {
    it('removes view by ID', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'file', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1 },
      ];
      const result = removeView(views, 'cv_1');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('cv_2');
    });

    it('returns same array if ID not found', () => {
      const views: CanvasView[] = [];
      expect(removeView(views, 'nonexistent')).toEqual([]);
    });
  });

  describe('updateViewPosition', () => {
    it('updates position and clamps to canvas bounds', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const result = updateViewPosition(views, 'cv_1', { x: 300, y: 400 });
      expect(result[0].position).toEqual({ x: 300, y: 400 });
    });

    it('allows negative positions within symmetric bounds', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const result = updateViewPosition(views, 'cv_1', { x: -100, y: -50 });
      expect(result[0].position.x).toBe(-100);
      expect(result[0].position.y).toBe(-50);
    });
  });

  describe('updateViewSize', () => {
    it('enforces minimum size', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const result = updateViewSize(views, 'cv_1', { width: 50, height: 50 });
      expect(result[0].size.width).toBe(MIN_VIEW_WIDTH);
      expect(result[0].size.height).toBe(MIN_VIEW_HEIGHT);
    });

    it('allows sizes above minimum', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 400, height: 300 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const result = updateViewSize(views, 'cv_1', { width: 600, height: 500 });
      expect(result[0].size).toEqual({ width: 600, height: 500 });
    });
  });

  describe('updateViewTitle', () => {
    it('updates view title', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'Old', zIndex: 0, agentId: null },
      ];
      const result = updateViewTitle(views, 'cv_1', 'New');
      expect(result[0].title).toBe('New');
    });
  });

  // ── Z-index / focus ────────────────────────────────────────────────

  describe('bringToFront', () => {
    it('sets highest zIndex on target view', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const result = bringToFront(views, 'cv_1', 2);
      expect(result.views.find((v) => v.id === 'cv_1')!.zIndex).toBe(2);
      expect(result.nextZIndex).toBe(3);
    });
  });

  // ── Viewport ───────────────────────────────────────────────────────

  describe('clampZoom', () => {
    it('clamps to min', () => expect(clampZoom(0.1)).toBe(MIN_ZOOM));
    it('clamps to max', () => expect(clampZoom(5)).toBe(MAX_ZOOM));
    it('passes through valid zoom', () => expect(clampZoom(1)).toBe(1));
  });

  describe('clampPosition', () => {
    it('allows moderate negative values (symmetric range)', () => {
      expect(clampPosition({ x: -10, y: -20 })).toEqual({ x: -10, y: -20 });
    });

    it('clamps values below -CANVAS_SIZE', () => {
      expect(clampPosition({ x: -(CANVAS_SIZE + 100), y: -(CANVAS_SIZE + 200) })).toEqual({ x: -CANVAS_SIZE, y: -CANVAS_SIZE });
    });

    it('clamps values above CANVAS_SIZE', () => {
      expect(clampPosition({ x: CANVAS_SIZE + 100, y: CANVAS_SIZE + 200 })).toEqual({ x: CANVAS_SIZE, y: CANVAS_SIZE });
    });

    it('passes through values within range', () => {
      expect(clampPosition({ x: 500, y: -300 })).toEqual({ x: 500, y: -300 });
    });
  });

  describe('clampViewport', () => {
    it('clamps zoom but preserves pan', () => {
      const vp = clampViewport({ panX: 100, panY: 200, zoom: 10 });
      expect(vp.zoom).toBe(MAX_ZOOM);
      expect(vp.panX).toBe(100);
      expect(vp.panY).toBe(200);
    });
  });

  describe('zoomTowardPoint', () => {
    it('preserves point under cursor', () => {
      const vp = { panX: 0, panY: 0, zoom: 1 };
      const result = zoomTowardPoint(vp, 2, 200, 200, { left: 0, top: 0 });
      expect(result.zoom).toBe(2);
      // The point (200,200) in screen space should map to same virtual position
    });

    it('clamps zoom to bounds', () => {
      const vp = { panX: 0, panY: 0, zoom: 1 };
      const result = zoomTowardPoint(vp, 10, 100, 100, { left: 0, top: 0 });
      expect(result.zoom).toBe(MAX_ZOOM);
    });
  });

  // ── Overlap detection & reflow ─────────────────────────────────────

  describe('detectOverlaps', () => {
    it('returns overlapping views', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
        { id: 'cv_3', type: 'agent', position: { x: 500, y: 500 }, size: { width: 200, height: 200 }, title: 'C', zIndex: 2, agentId: null },
      ];
      const overlaps = detectOverlaps(views, 'cv_1');
      expect(overlaps).toHaveLength(1);
      expect(overlaps[0].id).toBe('cv_2');
    });

    it('returns empty for non-overlapping views', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 200, y: 200 }, size: { width: 100, height: 100 }, title: 'B', zIndex: 1, agentId: null },
      ];
      expect(detectOverlaps(views, 'cv_1')).toHaveLength(0);
    });

    it('returns empty for unknown view ID', () => {
      expect(detectOverlaps([], 'nonexistent')).toHaveLength(0);
    });
  });

  describe('reflowViews', () => {
    it('shifts overlapping views right', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const result = reflowViews(views, 'cv_1', 'right');
      const movedView = result.find((v) => v.id === 'cv_2')!;
      expect(movedView.position.x).toBeGreaterThanOrEqual(200);
    });

    it('shifts overlapping views down', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 0, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const result = reflowViews(views, 'cv_1', 'down');
      const movedView = result.find((v) => v.id === 'cv_2')!;
      expect(movedView.position.y).toBeGreaterThanOrEqual(200);
    });

    it('returns views unchanged if no overlaps', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 100, height: 100 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 500, y: 500 }, size: { width: 100, height: 100 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const result = reflowViews(views, 'cv_1', 'right');
      expect(result).toEqual(views);
    });
  });

  // ── Viewport helpers ─────────────────────────────────────────────

  describe('computeBoundingBox', () => {
    it('returns null for empty array', () => {
      expect(computeBoundingBox([])).toBeNull();
    });

    it('computes bounding box of a single view', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 100, y: 200 }, size: { width: 300, height: 400 }, title: 'A', zIndex: 0, agentId: null },
      ];
      expect(computeBoundingBox(views)).toEqual({ x: 100, y: 200, width: 300, height: 400 });
    });

    it('computes bounding box of multiple views', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 300, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const bbox = computeBoundingBox(views);
      expect(bbox).toEqual({ x: 0, y: 0, width: 500, height: 300 });
    });

    it('handles views at negative positions', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: -100, y: -50 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
        { id: 'cv_2', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'B', zIndex: 1, agentId: null },
      ];
      const bbox = computeBoundingBox(views);
      expect(bbox).toEqual({ x: -100, y: -50, width: 400, height: 350 });
    });
  });

  describe('viewportToFitViews', () => {
    it('returns default viewport for empty views', () => {
      expect(viewportToFitViews([], 800, 600)).toEqual({ panX: 0, panY: 0, zoom: 1 });
    });

    it('fits a single view in the container', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const vp = viewportToFitViews(views, 800, 600);
      // Center should be at (200, 200) in canvas space
      // With zoom 1 and container 800x600, panX = 400/1 - 200 = 200, panY = 300/1 - 200 = 100
      expect(vp.zoom).toBeLessThanOrEqual(1);
      expect(vp.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    });

    it('zoom does not exceed 1', () => {
      const views: CanvasView[] = [
        { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 50, height: 50 }, title: 'A', zIndex: 0, agentId: null },
      ];
      const vp = viewportToFitViews(views, 800, 600);
      expect(vp.zoom).toBeLessThanOrEqual(1);
    });
  });

  describe('viewportToCenterView', () => {
    it('centers viewport on a view', () => {
      const view: CanvasView = { id: 'cv_1', type: 'agent', position: { x: 100, y: 100 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null };
      const vp = viewportToCenterView(view, 800, 600, 1);
      // Center of view is (200, 200). panX = 400 - 200 = 200, panY = 300 - 200 = 100
      expect(vp.panX).toBe(200);
      expect(vp.panY).toBe(100);
      expect(vp.zoom).toBe(1);
    });

    it('accounts for zoom when centering', () => {
      const view: CanvasView = { id: 'cv_1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 200, height: 200 }, title: 'A', zIndex: 0, agentId: null };
      const vp = viewportToCenterView(view, 800, 600, 2);
      // Center of view is (100, 100). panX = (400/2) - 100 = 100, panY = (300/2) - 100 = 50
      expect(vp.panX).toBe(100);
      expect(vp.panY).toBe(50);
      expect(vp.zoom).toBe(2);
    });
  });

  // ── Canvas instance helpers ────────────────────────────────────────

  describe('canvas instance IDs', () => {
    it('generates sequential canvas IDs', () => {
      const counter = createCanvasCounter(0);
      expect(generateCanvasId(counter)).toBe('canvas_1');
      expect(generateCanvasId(counter)).toBe('canvas_2');
    });

    it('syncs counter to existing instances', () => {
      const counter = createCanvasCounter(0);
      syncCounterToInstances(
        [{ id: 'canvas_5', name: 'A', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0 }],
        counter,
      );
      expect(counter.value).toBe(5);
      expect(generateCanvasId(counter)).toBe('canvas_6');
    });
  });
});
