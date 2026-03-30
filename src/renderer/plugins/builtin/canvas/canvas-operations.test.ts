import { describe, it, expect } from 'vitest';
import {
  generateViewId,
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
  generateCanvasId,
  screenToCanvas,
  canvasToScreen,
  isViewInZone,
  computeZoneContainment,
  computeZoneBounds,
  recomputeZones,
} from './canvas-operations';
import type { CanvasView, AgentCanvasView, StickyNoteCanvasView, ZoneCanvasView } from './canvas-types';
import { GRID_SIZE, MIN_VIEW_WIDTH, MIN_VIEW_HEIGHT, MIN_ZOOM, MAX_ZOOM, CANVAS_SIZE, MIN_ZONE_WIDTH, MIN_ZONE_HEIGHT, ZONE_PADDING, DEFAULT_STICKY_WIDTH, DEFAULT_STICKY_HEIGHT } from './canvas-types';

describe('canvas-operations', () => {
  // ── ID generation ──────────────────────────────────────────────────

  describe('generateViewId', () => {
    it('generates IDs with cv_ prefix and 8-char hex suffix', () => {
      const id = generateViewId();
      expect(id).toMatch(/^cv_[0-9a-f]{8}$/);
    });

    it('generates unique IDs on each call', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateViewId()));
      expect(ids.size).toBe(100);
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
    it('creates an agent view with random ID', () => {
      const view = createView('agent', { x: 100, y: 200 }, 0);
      expect(view.type).toBe('agent');
      expect(view.position).toEqual({ x: 100, y: 200 });
      expect((view as AgentCanvasView).agentId).toBeNull();
      expect(view.id).toMatch(/^cv_[0-9a-f]{8}$/);
    });

    it('snaps position to grid', () => {
      const view = createView('agent', { x: 13, y: 27 }, 0);
      expect(view.position.x % GRID_SIZE).toBe(0);
      expect(view.position.y % GRID_SIZE).toBe(0);
    });

    it('creates a sticky-note view with default content and color', () => {
      const view = createView('sticky-note', { x: 100, y: 200 }, 3);
      expect(view.type).toBe('sticky-note');
      expect(view.position).toEqual({ x: 100, y: 200 });
      expect(view.zIndex).toBe(3);
      expect(view.size).toEqual({ width: DEFAULT_STICKY_WIDTH, height: DEFAULT_STICKY_HEIGHT });
      expect((view as StickyNoteCanvasView).content).toBe('');
      expect((view as StickyNoteCanvasView).color).toBe('yellow');
      expect(view.displayName).toBe('Sticky Note');
    });

    it('deduplicates sticky-note display names', () => {
      const v1 = createView('sticky-note', { x: 0, y: 0 }, 0, ['Sticky Note']);
      expect(v1.displayName).toBe('Sticky Note (2)');
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
    it('generates canvas IDs with canvas_ prefix and 8-char hex suffix', () => {
      const id = generateCanvasId();
      expect(id).toMatch(/^canvas_[0-9a-f]{8}$/);
    });

    it('generates unique canvas IDs on each call', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateCanvasId()));
      expect(ids.size).toBe(100);
    });
  });

  // ── Coordinate conversion ──────────────────────────────────────────

  describe('screenToCanvas', () => {
    const rect = { left: 50, top: 30 };

    it('converts screen coords at zoom 1 with no pan', () => {
      const viewport = { panX: 0, panY: 0, zoom: 1 };
      const result = screenToCanvas(250, 230, rect, viewport);
      expect(result.x).toBe(200);
      expect(result.y).toBe(200);
    });

    it('accounts for zoom', () => {
      const viewport = { panX: 0, panY: 0, zoom: 2 };
      const result = screenToCanvas(250, 230, rect, viewport);
      // (250 - 50) / 2 - 0 = 100
      // (230 - 30) / 2 - 0 = 100
      expect(result.x).toBe(100);
      expect(result.y).toBe(100);
    });

    it('accounts for pan offset', () => {
      const viewport = { panX: 100, panY: 50, zoom: 1 };
      const result = screenToCanvas(250, 230, rect, viewport);
      // (250 - 50) / 1 - 100 = 100
      // (230 - 30) / 1 - 50 = 150
      expect(result.x).toBe(100);
      expect(result.y).toBe(150);
    });

    it('accounts for both zoom and pan', () => {
      const viewport = { panX: 50, panY: 25, zoom: 0.5 };
      const result = screenToCanvas(150, 130, rect, viewport);
      // (150 - 50) / 0.5 - 50 = 200 - 50 = 150
      // (130 - 30) / 0.5 - 25 = 200 - 25 = 175
      expect(result.x).toBe(150);
      expect(result.y).toBe(175);
    });

    it('handles fractional zoom', () => {
      const viewport = { panX: 0, panY: 0, zoom: 0.75 };
      const result = screenToCanvas(125, 105, rect, viewport);
      // (125 - 50) / 0.75 = 100
      // (105 - 30) / 0.75 = 100
      expect(result.x).toBe(100);
      expect(result.y).toBe(100);
    });
  });

  describe('canvasToScreen', () => {
    const rect = { left: 50, top: 30 };

    it('converts canvas coords at zoom 1 with no pan', () => {
      const viewport = { panX: 0, panY: 0, zoom: 1 };
      const result = canvasToScreen(200, 200, rect, viewport);
      expect(result.x).toBe(250);
      expect(result.y).toBe(230);
    });

    it('accounts for zoom', () => {
      const viewport = { panX: 0, panY: 0, zoom: 2 };
      const result = canvasToScreen(100, 100, rect, viewport);
      // (100 + 0) * 2 + 50 = 250
      // (100 + 0) * 2 + 30 = 230
      expect(result.x).toBe(250);
      expect(result.y).toBe(230);
    });

    it('accounts for pan offset', () => {
      const viewport = { panX: 100, panY: 50, zoom: 1 };
      const result = canvasToScreen(100, 150, rect, viewport);
      // (100 + 100) * 1 + 50 = 250
      // (150 + 50) * 1 + 30 = 230
      expect(result.x).toBe(250);
      expect(result.y).toBe(230);
    });

    it('is the inverse of screenToCanvas', () => {
      const viewport = { panX: -30, panY: 75, zoom: 1.5 };
      const clientX = 400;
      const clientY = 350;

      const canvasPos = screenToCanvas(clientX, clientY, rect, viewport);
      const screenPos = canvasToScreen(canvasPos.x, canvasPos.y, rect, viewport);

      expect(screenPos.x).toBeCloseTo(clientX, 10);
      expect(screenPos.y).toBeCloseTo(clientY, 10);
    });

    it('roundtrips correctly with extreme zoom', () => {
      const viewport = { panX: 500, panY: -200, zoom: 0.25 };
      const clientX = 200;
      const clientY = 150;

      const canvasPos = screenToCanvas(clientX, clientY, rect, viewport);
      const screenPos = canvasToScreen(canvasPos.x, canvasPos.y, rect, viewport);

      expect(screenPos.x).toBeCloseTo(clientX, 10);
      expect(screenPos.y).toBeCloseTo(clientY, 10);
    });
  });

  // ── Zone operations ─────────────────────────────────────────────

  function makeZone(overrides?: Partial<ZoneCanvasView>): ZoneCanvasView {
    return {
      id: 'zone_1',
      type: 'zone',
      position: { x: 0, y: 0 },
      size: { width: 600, height: 400 },
      title: 'test-zone',
      displayName: 'test-zone',
      zIndex: 0,
      metadata: {},
      themeId: 'catppuccin-mocha',
      containedViewIds: [],
      ...overrides,
    };
  }

  function makeAgentView(overrides?: Partial<AgentCanvasView>): AgentCanvasView {
    return {
      id: 'agent_1',
      type: 'agent',
      position: { x: 100, y: 100 },
      size: { width: 480, height: 480 },
      title: 'Agent',
      displayName: 'Agent',
      zIndex: 1,
      metadata: {},
      agentId: 'durable_1',
      ...overrides,
    };
  }

  describe('createView("zone")', () => {
    it('creates a zone view with correct defaults', () => {
      const view = createView('zone', { x: 100, y: 200 }, 5);
      expect(view.type).toBe('zone');
      expect(view.position).toEqual({ x: 100, y: 200 });
      expect(view.zIndex).toBe(5);
      const zone = view as ZoneCanvasView;
      expect(zone.themeId).toBe('catppuccin-mocha');
      expect(zone.containedViewIds).toEqual([]);
      expect(zone.size.width).toBe(600);
      expect(zone.size.height).toBe(400);
    });

    it('generates adjective-place display names', () => {
      const view = createView('zone', { x: 0, y: 0 }, 0);
      expect(view.displayName).toMatch(/^[a-z]+-[a-z]+$/);
    });
  });

  describe('isViewInZone', () => {
    it('returns true when widget is fully inside zone', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 600, height: 400 } });
      const agent = makeAgentView({ position: { x: 50, y: 50 }, size: { width: 200, height: 200 } });
      expect(isViewInZone(agent, zone)).toBe(true);
    });

    it('returns true when >50% overlap', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 600, height: 400 } });
      // Widget extends beyond zone but >50% inside
      const agent = makeAgentView({ position: { x: 500, y: 50 }, size: { width: 200, height: 200 } });
      // Overlap: 100*200 = 20000, area: 200*200 = 40000, ratio: 0.5 — exactly at boundary
      expect(isViewInZone(agent, zone)).toBe(false);
      // Move it one pixel in
      const agent2 = makeAgentView({ position: { x: 499, y: 50 }, size: { width: 200, height: 200 } });
      expect(isViewInZone(agent2, zone)).toBe(true);
    });

    it('rejects self', () => {
      const zone = makeZone();
      expect(isViewInZone(zone, zone)).toBe(false);
    });

    it('rejects other zones (no nesting)', () => {
      const zone = makeZone({ id: 'zone_1' });
      const zone2 = makeZone({ id: 'zone_2', position: { x: 50, y: 50 }, size: { width: 200, height: 200 } });
      expect(isViewInZone(zone2, zone)).toBe(false);
    });

    it('returns false when widget is fully outside', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 200, height: 200 } });
      const agent = makeAgentView({ position: { x: 500, y: 500 }, size: { width: 100, height: 100 } });
      expect(isViewInZone(agent, zone)).toBe(false);
    });
  });

  describe('computeZoneContainment', () => {
    it('finds views inside zone', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 600, height: 400 } });
      const inside = makeAgentView({ id: 'inside', position: { x: 50, y: 50 }, size: { width: 100, height: 100 } });
      const outside = makeAgentView({ id: 'outside', position: { x: 700, y: 700 }, size: { width: 100, height: 100 } });
      const result = computeZoneContainment(zone, [zone, inside, outside]);
      expect(result).toEqual(['inside']);
    });

    it('returns empty for zone with no contained views', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 200, height: 200 } });
      const outside = makeAgentView({ position: { x: 500, y: 500 } });
      expect(computeZoneContainment(zone, [zone, outside])).toEqual([]);
    });
  });

  describe('computeZoneBounds', () => {
    it('returns original bounds when no contained views', () => {
      const zone = makeZone({ position: { x: 100, y: 100 }, size: { width: 300, height: 300 } });
      const result = computeZoneBounds(zone, []);
      expect(result.position).toEqual({ x: 100, y: 100 });
      expect(result.size).toEqual({ width: 300, height: 300 });
    });

    it('expands to encompass contained views with padding', () => {
      const zone = makeZone();
      const widget = makeAgentView({ position: { x: 200, y: 200 }, size: { width: 100, height: 100 } });
      const result = computeZoneBounds(zone, [widget]);
      // Zone should encompass widget with ZONE_PADDING on each side
      expect(result.position.x).toBeLessThanOrEqual(200 - ZONE_PADDING);
      expect(result.position.y).toBeLessThanOrEqual(200 - ZONE_PADDING);
      expect(result.position.x + result.size.width).toBeGreaterThanOrEqual(300 + ZONE_PADDING);
      expect(result.position.y + result.size.height).toBeGreaterThanOrEqual(300 + ZONE_PADDING);
    });

    it('enforces minimum zone dimensions', () => {
      const zone = makeZone();
      const widget = makeAgentView({ position: { x: 0, y: 0 }, size: { width: 20, height: 20 } });
      const result = computeZoneBounds(zone, [widget]);
      expect(result.size.width).toBeGreaterThanOrEqual(MIN_ZONE_WIDTH);
      expect(result.size.height).toBeGreaterThanOrEqual(MIN_ZONE_HEIGHT);
    });
  });

  describe('recomputeZones', () => {
    it('updates containedViewIds based on spatial overlap', () => {
      const zone = makeZone({ position: { x: 0, y: 0 }, size: { width: 600, height: 400 } });
      const inside = makeAgentView({ id: 'inside', position: { x: 50, y: 80 }, size: { width: 100, height: 100 } });
      const outside = makeAgentView({ id: 'outside', position: { x: 800, y: 800 }, size: { width: 100, height: 100 } });
      const result = recomputeZones([zone, inside, outside]);
      const updatedZone = result.find((v) => v.id === 'zone_1') as ZoneCanvasView;
      expect(updatedZone.containedViewIds).toEqual(['inside']);
    });

    it('returns views unchanged when no zones exist', () => {
      const agent = makeAgentView();
      const result = recomputeZones([agent]);
      expect(result).toEqual([agent]);
    });
  });

  describe('updateViewSize for zones', () => {
    it('enforces minimum zone dimensions', () => {
      const zone = makeZone({ size: { width: 600, height: 400 } });
      const result = updateViewSize([zone], zone.id, { width: 100, height: 50 });
      const updated = result[0] as ZoneCanvasView;
      expect(updated.size.width).toBeGreaterThanOrEqual(MIN_ZONE_WIDTH);
      expect(updated.size.height).toBeGreaterThanOrEqual(MIN_ZONE_HEIGHT);
    });
  });
});
