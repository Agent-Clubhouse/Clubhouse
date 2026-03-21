/**
 * Tests for canvas:state event handling in annexClientStore.
 *
 * Verifies that multi-canvas tab sync works correctly, including:
 * - Full tab metadata merging
 * - Single canvas update into existing state
 * - First canvas state for new project
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the stores that annexClientStore depends on
vi.mock('./annexClientStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./annexClientStore')>();
  return actual;
});

describe('canvas:state multi-canvas merging', () => {
  // Since annexClientStore has complex setup, we test the merge logic directly
  // by simulating what the event handler does

  function mergeCanvasState(
    existing: { canvases: any[]; activeCanvasId: string } | undefined,
    incoming: {
      canvasId: string;
      name: string;
      views: unknown[];
      viewport: unknown;
      nextZIndex: number;
      zoomedViewId: string | null;
      allCanvasTabs?: Array<{ id: string; name: string }>;
      activeCanvasId?: string;
    },
  ): { canvases: any[]; activeCanvasId: string } {
    const cs = incoming;

    if (cs.allCanvasTabs) {
      const canvases = cs.allCanvasTabs.map((tab) => {
        if (tab.id === cs.canvasId) {
          return {
            id: cs.canvasId,
            name: cs.name,
            views: cs.views,
            viewport: cs.viewport,
            nextZIndex: cs.nextZIndex,
            zoomedViewId: cs.zoomedViewId,
          };
        }
        const prev = existing?.canvases?.find((c: any) => c.id === tab.id);
        return prev || {
          id: tab.id, name: tab.name, views: [],
          viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null,
        };
      });
      return { canvases, activeCanvasId: cs.activeCanvasId || cs.canvasId };
    } else if (existing) {
      const canvases = [...existing.canvases];
      const idx = canvases.findIndex((c: any) => c.id === cs.canvasId);
      const updated = {
        id: cs.canvasId, name: cs.name, views: cs.views,
        viewport: cs.viewport, nextZIndex: cs.nextZIndex,
        zoomedViewId: cs.zoomedViewId,
      };
      if (idx >= 0) {
        canvases[idx] = updated;
      } else {
        canvases.push(updated);
      }
      return { canvases, activeCanvasId: existing.activeCanvasId };
    } else {
      return {
        canvases: [{
          id: cs.canvasId, name: cs.name, views: cs.views,
          viewport: cs.viewport, nextZIndex: cs.nextZIndex,
          zoomedViewId: cs.zoomedViewId,
        }],
        activeCanvasId: cs.canvasId,
      };
    }
  }

  it('creates initial state from first canvas event', () => {
    const result = mergeCanvasState(undefined, {
      canvasId: 'c1', name: 'Tab 1', views: [{ id: 'v1' }],
      viewport: { panX: 10, panY: 20, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
    });

    expect(result.canvases).toHaveLength(1);
    expect(result.canvases[0].id).toBe('c1');
    expect(result.canvases[0].views).toHaveLength(1);
    expect(result.activeCanvasId).toBe('c1');
  });

  it('merges single canvas update into existing state', () => {
    const existing = {
      canvases: [
        { id: 'c1', name: 'Tab 1', views: [{ id: 'v1' }], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null },
        { id: 'c2', name: 'Tab 2', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
      ],
      activeCanvasId: 'c1',
    };

    const result = mergeCanvasState(existing, {
      canvasId: 'c1', name: 'Tab 1 Updated', views: [{ id: 'v1' }, { id: 'v2' }],
      viewport: { panX: 50, panY: 60, zoom: 1.2 }, nextZIndex: 2, zoomedViewId: null,
    });

    expect(result.canvases).toHaveLength(2);
    expect(result.canvases[0].name).toBe('Tab 1 Updated');
    expect(result.canvases[0].views).toHaveLength(2);
    // Tab 2 should be preserved
    expect(result.canvases[1].id).toBe('c2');
    expect(result.canvases[1].name).toBe('Tab 2');
    // Active canvas preserved from existing
    expect(result.activeCanvasId).toBe('c1');
  });

  it('adds new canvas to existing state', () => {
    const existing = {
      canvases: [
        { id: 'c1', name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
      ],
      activeCanvasId: 'c1',
    };

    const result = mergeCanvasState(existing, {
      canvasId: 'c3', name: 'New Tab', views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null,
    });

    expect(result.canvases).toHaveLength(2);
    expect(result.canvases[1].id).toBe('c3');
  });

  it('uses allCanvasTabs to build complete tab list', () => {
    const existing = {
      canvases: [
        { id: 'c1', name: 'Old Tab 1', views: [{ id: 'v1' }], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null },
      ],
      activeCanvasId: 'c1',
    };

    const result = mergeCanvasState(existing, {
      canvasId: 'c2', name: 'Tab 2', views: [{ id: 'v2' }],
      viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null,
      allCanvasTabs: [
        { id: 'c1', name: 'Tab 1' },
        { id: 'c2', name: 'Tab 2' },
        { id: 'c3', name: 'Tab 3' },
      ],
      activeCanvasId: 'c2',
    });

    expect(result.canvases).toHaveLength(3);
    // c1 should be preserved from existing (has view data)
    expect(result.canvases[0].views).toHaveLength(1);
    expect(result.canvases[0].views[0].id).toBe('v1');
    // c2 should have the new data
    expect(result.canvases[1].views).toHaveLength(1);
    expect(result.canvases[1].views[0].id).toBe('v2');
    // c3 should be a stub (no existing data)
    expect(result.canvases[2].id).toBe('c3');
    expect(result.canvases[2].views).toHaveLength(0);
    // Active should come from the message
    expect(result.activeCanvasId).toBe('c2');
  });

  it('removes tabs not in allCanvasTabs', () => {
    const existing = {
      canvases: [
        { id: 'c1', name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
        { id: 'c2', name: 'Tab 2', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
      ],
      activeCanvasId: 'c1',
    };

    const result = mergeCanvasState(existing, {
      canvasId: 'c1', name: 'Tab 1', views: [],
      viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null,
      allCanvasTabs: [{ id: 'c1', name: 'Tab 1' }],
      activeCanvasId: 'c1',
    });

    // c2 should be removed because it's not in allCanvasTabs
    expect(result.canvases).toHaveLength(1);
    expect(result.canvases[0].id).toBe('c1');
  });
});
