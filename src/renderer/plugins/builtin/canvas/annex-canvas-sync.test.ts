/**
 * Tests for canvas-over-annex bidirectional sync functionality.
 *
 * Covers: new mutation types, remote mutation forwarding, tab metadata
 * in broadcasts, multi-canvas state merging, and hydrateFromRemote
 * viewport preservation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyCanvasMutation, broadcastCanvasState, sendRemoteCanvasMutation } from './canvas-sync';
import { createCanvasStore } from './canvas-store';
import type { CanvasMutation } from '../../../../shared/types';

// Mock remoteProjectStore
vi.mock('../../../stores/remoteProjectStore', () => ({
  parseNamespacedId: (id: string) => {
    if (!id.startsWith('remote||')) return null;
    const rest = id.slice('remote||'.length);
    const sep = rest.indexOf('||');
    if (sep === -1) return null;
    return { satelliteId: rest.slice(0, sep), agentId: rest.slice(sep + 2) };
  },
  isRemoteProjectId: (id: string) => id.startsWith('remote||'),
}));

describe('annex canvas sync', () => {
  let store: ReturnType<typeof createCanvasStore>;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createCanvasStore();
    broadcastSpy = vi.fn();
    window.clubhouse.window.broadcastCanvasState = broadcastSpy;
  });

  // ── New mutation types ─────────────────────────────────────────────

  describe('tab management mutations', () => {
    it('applies addCanvas mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(store, canvasId, { type: 'addCanvas' });

      expect(store.getState().canvases).toHaveLength(2);
      expect(broadcastSpy).toHaveBeenCalled();
    });

    it('applies removeCanvas mutation', () => {
      // Add a second canvas first
      store.getState().addCanvas();
      expect(store.getState().canvases).toHaveLength(2);
      const firstId = store.getState().canvases[0].id;

      applyCanvasMutation(store, firstId, { type: 'removeCanvas', canvasId: firstId });

      expect(store.getState().canvases).toHaveLength(1);
      expect(broadcastSpy).toHaveBeenCalled();
    });

    it('applies renameCanvas mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(store, canvasId, {
        type: 'renameCanvas',
        canvasId,
        name: 'Test Canvas',
      });

      const canvas = store.getState().canvases.find((c) => c.id === canvasId);
      expect(canvas?.name).toBe('Test Canvas');
      expect(broadcastSpy).toHaveBeenCalled();
    });

    it('applies setActiveCanvas mutation', () => {
      const secondId = store.getState().addCanvas();
      const firstId = store.getState().canvases[0].id;
      store.getState().setActiveCanvas(firstId);

      applyCanvasMutation(store, firstId, {
        type: 'setActiveCanvas',
        canvasId: secondId,
      });

      expect(store.getState().activeCanvasId).toBe(secondId);
      expect(broadcastSpy).toHaveBeenCalled();
    });
  });

  describe('moveViews mutation', () => {
    it('applies moveViews mutation with multiple views', () => {
      const canvasId = store.getState().activeCanvasId;
      const id1 = store.getState().addView('agent', { x: 0, y: 0 });
      const id2 = store.getState().addView('agent', { x: 100, y: 100 });

      const mutation: CanvasMutation = {
        type: 'moveViews',
        positions: {
          [id1]: { x: 200, y: 300 },
          [id2]: { x: 400, y: 500 },
        },
      };

      applyCanvasMutation(store, canvasId, mutation);

      const views = store.getState().views;
      expect(views.find((v) => v.id === id1)?.position).toEqual({ x: 200, y: 300 });
      expect(views.find((v) => v.id === id2)?.position).toEqual({ x: 400, y: 500 });
    });
  });

  // ── Tab metadata in broadcasts ─────────────────────────────────────

  describe('broadcastCanvasState with tab metadata', () => {
    it('includes allCanvasTabs in snapshot', () => {
      const canvasId = store.getState().activeCanvasId;
      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.allCanvasTabs).toBeDefined();
      expect(snapshot.allCanvasTabs).toHaveLength(1);
      expect(snapshot.allCanvasTabs[0].id).toBe(canvasId);
    });

    it('includes all tabs when multiple canvases exist', () => {
      const secondId = store.getState().addCanvas();
      const firstId = store.getState().canvases[0].id;

      broadcastCanvasState(store, firstId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.allCanvasTabs).toHaveLength(2);
      const tabIds = snapshot.allCanvasTabs.map((t: any) => t.id);
      expect(tabIds).toContain(firstId);
      expect(tabIds).toContain(secondId);
    });

    it('includes activeCanvasId in snapshot', () => {
      const canvasId = store.getState().activeCanvasId;
      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.activeCanvasId).toBe(canvasId);
    });
  });

  // ── hydrateFromRemote viewport preservation ────────────────────────

  describe('hydrateFromRemote', () => {
    it('preserves local viewport on subsequent hydrations', () => {
      const canvasId = 'remote-canvas-1';

      // Initial hydration
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
      );

      // User pans locally
      store.getState().setViewport({ panX: 500, panY: 300, zoom: 1.5 });
      expect(store.getState().viewport).toEqual({ panX: 500, panY: 300, zoom: 1.5 });

      // Re-hydrate from satellite (views changed, viewport different)
      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [{ id: 'v1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {} }], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1, zoomedViewId: null }],
        canvasId,
      );

      // Local viewport should be preserved
      expect(store.getState().viewport).toEqual({ panX: 500, panY: 300, zoom: 1.5 });
      // But views should be updated
      expect(store.getState().views).toHaveLength(1);
    });

    it('uses remote viewport on first hydration', () => {
      const canvasId = 'remote-canvas-2';

      store.getState().hydrateFromRemote(
        [{ id: canvasId, name: 'Tab 1', views: [], viewport: { panX: 100, panY: 200, zoom: 0.8 }, nextZIndex: 0, zoomedViewId: null }],
        canvasId,
      );

      expect(store.getState().viewport).toEqual({ panX: 100, panY: 200, zoom: 0.8 });
    });

    it('preserves local active canvas on subsequent hydrations', () => {
      // Initial hydration with two canvases
      store.getState().hydrateFromRemote(
        [
          { id: 'tab-a', name: 'Tab A', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
          { id: 'tab-b', name: 'Tab B', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
        ],
        'tab-a',
      );

      // User switches to tab B locally
      store.getState().setActiveCanvas('tab-b');
      expect(store.getState().activeCanvasId).toBe('tab-b');

      // Re-hydrate with satellite active = tab-a
      store.getState().hydrateFromRemote(
        [
          { id: 'tab-a', name: 'Tab A', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
          { id: 'tab-b', name: 'Tab B', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
        ],
        'tab-a',
      );

      // Controller should keep tab-b active
      expect(store.getState().activeCanvasId).toBe('tab-b');
    });

    it('follows satellite active tab when local tab is removed', () => {
      // Initial hydration
      store.getState().hydrateFromRemote(
        [
          { id: 'tab-a', name: 'Tab A', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
          { id: 'tab-b', name: 'Tab B', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
        ],
        'tab-a',
      );

      // User views tab-b
      store.getState().setActiveCanvas('tab-b');

      // Satellite removes tab-b
      store.getState().hydrateFromRemote(
        [
          { id: 'tab-a', name: 'Tab A', views: [], viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 0, zoomedViewId: null },
        ],
        'tab-a',
      );

      // Controller should fall back to satellite's active (tab-a)
      expect(store.getState().activeCanvasId).toBe('tab-a');
    });
  });

  // ── sendRemoteCanvasMutation ───────────────────────────────────────

  describe('sendRemoteCanvasMutation', () => {
    it('parses namespaced project ID and calls annexClient', () => {
      const canvasMutationSpy = vi.fn();
      window.clubhouse.annexClient = {
        ...window.clubhouse.annexClient,
        canvasMutation: canvasMutationSpy,
      };

      sendRemoteCanvasMutation(
        'remote||sat-123||proj-456',
        'canvas-1',
        'project',
        { type: 'addView', viewType: 'agent', position: { x: 0, y: 0 } },
      );

      expect(canvasMutationSpy).toHaveBeenCalledWith(
        'sat-123',
        'proj-456',
        'canvas-1',
        'project',
        { type: 'addView', viewType: 'agent', position: { x: 0, y: 0 } },
      );
    });

    it('does nothing for invalid namespaced ID', () => {
      const canvasMutationSpy = vi.fn();
      window.clubhouse.annexClient = {
        ...window.clubhouse.annexClient,
        canvasMutation: canvasMutationSpy,
      };

      sendRemoteCanvasMutation('local-project', 'canvas-1', 'project', { type: 'addCanvas' });

      expect(canvasMutationSpy).not.toHaveBeenCalled();
    });
  });
});
