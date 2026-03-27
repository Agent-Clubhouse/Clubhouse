import { describe, it, expect } from 'vitest';
import type { CanvasView, AgentCanvasView, AnchorCanvasView, PluginCanvasView, Viewport, Size } from './canvas-types';
import {
  viewportToCanvasRect,
  computeMinimapBounds,
  canvasToMinimap,
  minimapToCanvas,
  centerViewportOn,
  MINIMAP_WORLD_PADDING_FACTOR,
  MINIMAP_WIDTH,
  MINIMAP_HEIGHT,
  MINIMAP_INITIAL_HIDE_DELAY,
  MINIMAP_INTERACTION_HIDE_DELAY,
} from './canvas-minimap';

// ── Factories ────────────────────────────────────────────────────────

function makeAgentView(overrides: Partial<AgentCanvasView> = {}): AgentCanvasView {
  return {
    id: 'v1',
    type: 'agent',
    position: { x: 100, y: 100 },
    size: { width: 480, height: 480 },
    title: 'Agent',
    displayName: 'Agent',
    zIndex: 0,
    metadata: {},
    agentId: 'a1',
    ...overrides,
  };
}

function makeAnchorView(overrides: Partial<AnchorCanvasView> = {}): AnchorCanvasView {
  return {
    id: 'anchor1',
    type: 'anchor',
    position: { x: 500, y: 200 },
    size: { width: 240, height: 50 },
    title: 'Anchor',
    displayName: 'Anchor',
    zIndex: 0,
    metadata: {},
    label: 'Anchor',
    ...overrides,
  };
}

function makePluginView(overrides: Partial<PluginCanvasView> = {}): PluginCanvasView {
  return {
    id: 'pv1',
    type: 'plugin',
    position: { x: 600, y: 600 },
    size: { width: 480, height: 480 },
    title: 'Terminal',
    displayName: 'Terminal',
    zIndex: 0,
    metadata: {},
    pluginWidgetType: 'plugin:terminal:shell',
    pluginId: 'terminal',
    ...overrides,
  };
}

const defaultViewport: Viewport = { panX: 0, panY: 0, zoom: 1 };
const defaultContainer: Size = { width: 1200, height: 800 };

// ── viewportToCanvasRect ─────────────────────────────────────────────

describe('viewportToCanvasRect', () => {
  it('computes visible canvas area at zoom 1', () => {
    const rect = viewportToCanvasRect({ panX: 0, panY: 0, zoom: 1 }, { width: 1200, height: 800 });
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.width).toBe(1200);
    expect(rect.height).toBe(800);
  });

  it('adjusts for pan offset', () => {
    const rect = viewportToCanvasRect({ panX: -100, panY: -200, zoom: 1 }, { width: 1200, height: 800 });
    expect(rect).toEqual({ x: 100, y: 200, width: 1200, height: 800 });
  });

  it('adjusts for zoom', () => {
    const rect = viewportToCanvasRect({ panX: 0, panY: 0, zoom: 2 }, { width: 1200, height: 800 });
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.width).toBe(600);
    expect(rect.height).toBe(400);
  });

  it('combines pan and zoom', () => {
    const rect = viewportToCanvasRect({ panX: -50, panY: -100, zoom: 0.5 }, { width: 1200, height: 800 });
    expect(rect).toEqual({ x: 50, y: 100, width: 2400, height: 1600 });
  });
});

// ── computeMinimapBounds ─────────────────────────────────────────────

describe('computeMinimapBounds', () => {
  it('returns padded viewport when no views exist', () => {
    const bounds = computeMinimapBounds([], defaultViewport, defaultContainer);
    // Should be viewport rect with 25% padding
    expect(bounds.width).toBeGreaterThan(1200);
    expect(bounds.height).toBeGreaterThan(800);
  });

  it('computes 1.5x padded bounding box of views', () => {
    const views: CanvasView[] = [
      makeAgentView({ position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }),
    ];
    const vp: Viewport = { panX: 1000, panY: 1000, zoom: 0.1 }; // viewport far away and small
    const container: Size = { width: 100, height: 100 }; // small container at low zoom → 1000x1000 canvas rect, but centered far in negative space

    const bounds = computeMinimapBounds(views, vp, container);

    // The bounds should include both the padded bbox and the viewport
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it('includes viewport when it extends beyond padded content', () => {
    const views: CanvasView[] = [
      makeAgentView({ position: { x: 0, y: 0 }, size: { width: 200, height: 200 } }),
    ];
    // Viewport is panned far to the right
    const vp: Viewport = { panX: -2000, panY: 0, zoom: 1 };
    const container: Size = { width: 800, height: 600 };

    const bounds = computeMinimapBounds(views, vp, container);

    // Viewport x range is [2000, 2800], content is [0, 200] with 1.5x padding → [-50, 250]
    // Union should extend to at least x=2800
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(2800);
  });

  it('uses 1.5x content bbox when viewport is within it', () => {
    const views: CanvasView[] = [
      makeAgentView({ position: { x: 0, y: 0 }, size: { width: 1000, height: 1000 } }),
    ];
    // Viewport is centered on the content
    const vp: Viewport = { panX: 100, panY: 100, zoom: 1 };
    const container: Size = { width: 800, height: 600 };

    const bounds = computeMinimapBounds(views, vp, container);

    // 1.5x of 1000x1000 = padded to 1500x1500, centered
    // Content bbox: [0,0] to [1000,1000], extra each side = 250
    const expectedW = 1000 * MINIMAP_WORLD_PADDING_FACTOR;
    expect(bounds.width).toBeGreaterThanOrEqual(expectedW);
    expect(bounds.height).toBeGreaterThanOrEqual(1000 * MINIMAP_WORLD_PADDING_FACTOR);
  });
});

// ── canvasToMinimap ──────────────────────────────────────────────────

describe('canvasToMinimap', () => {
  it('maps a rect at the origin of world bounds to minimap origin', () => {
    const worldBounds = { x: 0, y: 0, width: 1000, height: 700 };
    const minimapSize: Size = { width: 200, height: 140 };
    const rect = canvasToMinimap({ x: 0, y: 0, width: 100, height: 70 }, worldBounds, minimapSize);

    // Scale = min(200/1000, 140/700) = min(0.2, 0.2) = 0.2
    // renderedW = 200, renderedH = 140 → offset = 0,0
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    expect(rect.width).toBeCloseTo(20);
    expect(rect.height).toBeCloseTo(14);
  });

  it('centers content when aspect ratios differ', () => {
    const worldBounds = { x: 0, y: 0, width: 2000, height: 500 };
    const minimapSize: Size = { width: 200, height: 140 };

    // Scale = min(200/2000, 140/500) = min(0.1, 0.28) = 0.1
    // renderedW = 200, renderedH = 50 → offsetY = (140 - 50)/2 = 45
    const rect = canvasToMinimap({ x: 0, y: 0, width: 2000, height: 500 }, worldBounds, minimapSize);
    expect(rect.y).toBeCloseTo(45);
    expect(rect.width).toBeCloseTo(200);
    expect(rect.height).toBeCloseTo(50);
  });

  it('handles negative canvas coordinates', () => {
    const worldBounds = { x: -500, y: -300, width: 1000, height: 700 };
    const minimapSize: Size = { width: 200, height: 140 };
    const rect = canvasToMinimap({ x: -500, y: -300, width: 100, height: 70 }, worldBounds, minimapSize);

    // Should be at minimap origin
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
  });
});

// ── minimapToCanvas (round-trip) ─────────────────────────────────────

describe('minimapToCanvas', () => {
  it('round-trips with canvasToMinimap for a point inside bounds', () => {
    const worldBounds = { x: 0, y: 0, width: 1000, height: 700 };
    const minimapSize: Size = { width: 200, height: 140 };

    // Map canvas point (250, 350) to minimap, then back
    const miniRect = canvasToMinimap({ x: 250, y: 350, width: 0, height: 0 }, worldBounds, minimapSize);
    const back = minimapToCanvas(miniRect.x, miniRect.y, worldBounds, minimapSize);

    expect(back.x).toBeCloseTo(250);
    expect(back.y).toBeCloseTo(350);
  });

  it('maps minimap center to world center', () => {
    const worldBounds = { x: 100, y: 200, width: 800, height: 600 };
    const minimapSize: Size = { width: 200, height: 140 };

    const center = minimapToCanvas(100, 70, worldBounds, minimapSize);

    // Center of world = (100 + 400, 200 + 300) = (500, 500)
    // But we need to account for aspect ratio centering
    // Scale = min(200/800, 140/600) = min(0.25, 0.233) = 0.233
    // renderedW = 800*0.233 = 186.67, renderedH = 140
    // offsetX = (200 - 186.67)/2 = 6.67
    // canvasX = 100 + (100 - 6.67) / 0.233 = 100 + 400 = 500
    expect(center.x).toBeCloseTo(500, 0);
    expect(center.y).toBeCloseTo(500, 0);
  });
});

// ── centerViewportOn ─────────────────────────────────────────────────

describe('centerViewportOn', () => {
  it('computes pan to center a point at zoom 1', () => {
    const result = centerViewportOn({ x: 500, y: 300 }, { width: 1200, height: 800 }, 1);
    // panX = 1200/2/1 - 500 = 600 - 500 = 100
    // panY = 800/2/1 - 300 = 400 - 300 = 100
    expect(result.panX).toBe(100);
    expect(result.panY).toBe(100);
  });

  it('accounts for zoom', () => {
    const result = centerViewportOn({ x: 500, y: 300 }, { width: 1200, height: 800 }, 2);
    // panX = 1200/2/2 - 500 = 300 - 500 = -200
    expect(result.panX).toBe(-200);
    expect(result.panY).toBe(-100);
  });
});

// ── Constants ────────────────────────────────────────────────────────

describe('constants', () => {
  it('has sensible default dimensions', () => {
    expect(MINIMAP_WIDTH).toBe(200);
    expect(MINIMAP_HEIGHT).toBe(140);
  });

  it('has a positive initial hide delay', () => {
    expect(MINIMAP_INITIAL_HIDE_DELAY).toBe(3000);
  });

  it('has a shorter interaction hide delay', () => {
    expect(MINIMAP_INTERACTION_HIDE_DELAY).toBe(1000);
    expect(MINIMAP_INTERACTION_HIDE_DELAY).toBeLessThan(MINIMAP_INITIAL_HIDE_DELAY);
  });

  it('has padding factor > 1', () => {
    expect(MINIMAP_WORLD_PADDING_FACTOR).toBeGreaterThan(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────

describe('edge cases', () => {
  it('handles zero-size views in bounding box', () => {
    const views: CanvasView[] = [
      makeAgentView({ position: { x: 100, y: 100 }, size: { width: 0, height: 0 } }),
    ];
    const bounds = computeMinimapBounds(views, defaultViewport, defaultContainer);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.height).toBeGreaterThan(0);
  });

  it('handles very zoomed out viewport', () => {
    const vp: Viewport = { panX: 0, panY: 0, zoom: 0.25 };
    const container: Size = { width: 1200, height: 800 };
    const rect = viewportToCanvasRect(vp, container);
    expect(rect.width).toBe(4800);
    expect(rect.height).toBe(3200);
  });

  it('handles multiple views spread across canvas', () => {
    const views: CanvasView[] = [
      makeAgentView({ id: 'v1', position: { x: -5000, y: -5000 }, size: { width: 200, height: 200 } }),
      makeAgentView({ id: 'v2', position: { x: 5000, y: 5000 }, size: { width: 200, height: 200 } }),
    ];
    const bounds = computeMinimapBounds(views, defaultViewport, defaultContainer);

    // Content spans from -5000 to 5200 in both axes = 10200
    // 1.5x = 15300
    expect(bounds.width).toBeGreaterThanOrEqual(10200 * MINIMAP_WORLD_PADDING_FACTOR);
  });

  it('includes all view types in bounds computation', () => {
    const views: CanvasView[] = [
      makeAgentView({ id: 'v1', position: { x: 0, y: 0 }, size: { width: 100, height: 100 } }),
      makeAnchorView({ id: 'a1', position: { x: 1000, y: 0 }, size: { width: 240, height: 50 } }),
      makePluginView({ id: 'p1', position: { x: 0, y: 1000 }, size: { width: 200, height: 200 } }),
    ];
    const bounds = computeMinimapBounds(views, defaultViewport, defaultContainer);

    // Content x range: [0, 1240], y range: [0, 1200]
    expect(bounds.x + bounds.width).toBeGreaterThanOrEqual(1240);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(1200);
  });
});
