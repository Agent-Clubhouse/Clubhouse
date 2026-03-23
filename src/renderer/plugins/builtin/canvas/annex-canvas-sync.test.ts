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

  // ── projectId propagation in applyCanvasMutation ────────────────────
  //
  // The satellite's main process only forwards canvas:state to annex
  // controllers when the broadcast payload includes a projectId.
  // Without it, mutations applied on the satellite are silently dropped
  // and never reach the controller.

  describe('applyCanvasMutation with projectId', () => {
    it('broadcasts projectId and scope for addView mutations', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(
        store, canvasId,
        { type: 'addView', viewType: 'agent', position: { x: 0, y: 0 } },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.projectId).toBe('proj-abc');
      expect(snapshot.scope).toBe('project');
    });

    it('broadcasts projectId and scope for removeView mutations', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      broadcastSpy.mockClear();

      applyCanvasMutation(
        store, canvasId,
        { type: 'removeView', viewId },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-abc');
    });

    it('broadcasts projectId and scope for updateView mutations (agent pick)', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      broadcastSpy.mockClear();

      // Simulate picking an agent — the exact mutation the controller sends
      applyCanvasMutation(
        store, canvasId,
        {
          type: 'updateView', viewId,
          updates: {
            agentId: 'remote||sat-123||agent-456',
            projectId: 'remote||sat-123||proj-789',
            title: 'mega-camel',
            displayName: 'mega-camel',
            metadata: { agentId: 'remote||sat-123||agent-456' },
          },
        },
        'proj-789', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.projectId).toBe('proj-789');
      expect(snapshot.scope).toBe('project');
      // The view should also have the agentId set
      const updatedView = snapshot.views.find((v: any) => v.id === viewId);
      expect(updatedView.agentId).toBe('remote||sat-123||agent-456');
    });

    it('broadcasts projectId for addCanvas mutations', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(
        store, canvasId,
        { type: 'addCanvas' },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-abc');
    });

    it('broadcasts projectId for removeCanvas mutations', () => {
      store.getState().addCanvas();
      const firstId = store.getState().canvases[0].id;
      broadcastSpy.mockClear();

      applyCanvasMutation(
        store, firstId,
        { type: 'removeCanvas', canvasId: firstId },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-abc');
    });

    it('broadcasts projectId for renameCanvas mutations', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(
        store, canvasId,
        { type: 'renameCanvas', canvasId, name: 'Renamed' },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-abc');
    });

    it('broadcasts projectId for moveView mutations', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      broadcastSpy.mockClear();

      applyCanvasMutation(
        store, canvasId,
        { type: 'moveView', viewId, position: { x: 100, y: 200 } },
        'proj-abc', 'project',
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-abc');
    });

    it('broadcasts without projectId when not provided (pop-out windows)', () => {
      const canvasId = store.getState().activeCanvasId;
      applyCanvasMutation(
        store, canvasId,
        { type: 'addView', viewType: 'agent', position: { x: 0, y: 0 } },
      );

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.projectId).toBeUndefined();
      expect(snapshot.scope).toBeUndefined();
    });
  });

  // ── Round-trip annex mutation scenarios ─────────────────────────────
  //
  // Simulates the full controller → satellite → controller flow.

  describe('annex canvas mutation round-trip', () => {
    it('updateView (agent pick) round-trips through hydration', () => {
      const canvasId = 'shared-canvas-1';

      // Satellite canvas state: one empty agent view
      const satelliteStore = createCanvasStore();
      satelliteStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_view1', type: 'agent',
            position: { x: 100, y: 100 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      // Controller applies updateView mutation (picks agent) on satellite
      applyCanvasMutation(
        satelliteStore, canvasId,
        {
          type: 'updateView', viewId: 'cv_view1',
          updates: {
            agentId: 'remote||sat-1||agent-1',
            title: 'mega-camel',
            displayName: 'mega-camel',
          },
        },
        'proj-1', 'project',
      );

      // Verify the satellite store has the update
      const updatedView = satelliteStore.getState().views.find((v) => v.id === 'cv_view1');
      expect((updatedView as any).agentId).toBe('remote||sat-1||agent-1');
      expect(updatedView!.title).toBe('mega-camel');

      // Verify the broadcast includes projectId for annex routing
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-1');

      // Controller hydrates from the broadcast (simulating the full round-trip)
      const controllerStore = createCanvasStore();
      const broadcastData = broadcastSpy.mock.calls[0][0];
      controllerStore.getState().hydrateFromRemote(
        [{ id: broadcastData.canvasId, name: broadcastData.name, views: broadcastData.views, viewport: broadcastData.viewport, nextZIndex: broadcastData.nextZIndex, zoomedViewId: broadcastData.zoomedViewId }],
        broadcastData.activeCanvasId,
      );

      // Controller should see the agent assignment
      const controllerView = controllerStore.getState().views.find((v) => v.id === 'cv_view1');
      expect((controllerView as any).agentId).toBe('remote||sat-1||agent-1');
      expect(controllerView!.displayName).toBe('mega-camel');
    });

    it('removeView round-trips — prevents stuck cards', () => {
      const canvasId = 'shared-canvas-2';

      // Satellite has two views
      const satelliteStore = createCanvasStore();
      satelliteStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 2, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [
            { id: 'cv_a', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
            { id: 'cv_b', type: 'agent', position: { x: 500, y: 0 }, size: { width: 480, height: 480 }, title: 'B', displayName: 'B', zIndex: 1, metadata: {} },
          ],
        }],
        canvasId,
      );

      // Controller removes view B
      applyCanvasMutation(
        satelliteStore, canvasId,
        { type: 'removeView', viewId: 'cv_b' },
        'proj-1', 'project',
      );

      // View B should be gone
      expect(satelliteStore.getState().views).toHaveLength(1);
      expect(satelliteStore.getState().views[0].id).toBe('cv_a');

      // Broadcast includes projectId — annex server will forward to controller
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-1');
      expect(broadcastSpy.mock.calls[0][0].views).toHaveLength(1);

      // Controller hydrates — card B should not reappear (no stuck card)
      const controllerStore = createCanvasStore();
      const broadcastData = broadcastSpy.mock.calls[0][0];
      controllerStore.getState().hydrateFromRemote(
        [{ id: broadcastData.canvasId, name: broadcastData.name, views: broadcastData.views, viewport: broadcastData.viewport, nextZIndex: broadcastData.nextZIndex, zoomedViewId: broadcastData.zoomedViewId }],
        broadcastData.activeCanvasId,
      );

      expect(controllerStore.getState().views).toHaveLength(1);
      expect(controllerStore.getState().views[0].id).toBe('cv_a');
    });

    it('addView round-trips — new card appears on controller', () => {
      const canvasId = 'shared-canvas-3';

      const satelliteStore = createCanvasStore();
      satelliteStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 0, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [],
        }],
        canvasId,
      );

      applyCanvasMutation(
        satelliteStore, canvasId,
        { type: 'addView', viewType: 'agent', position: { x: 200, y: 200 } },
        'proj-1', 'project',
      );

      expect(satelliteStore.getState().views).toHaveLength(1);
      expect(broadcastSpy.mock.calls[0][0].projectId).toBe('proj-1');
      expect(broadcastSpy.mock.calls[0][0].views).toHaveLength(1);
    });
  });

  // ── selectView mutation + selectedViewId sync ──────────────────────

  describe('selectView mutation', () => {
    it('applies selectView via applyCanvasMutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      broadcastSpy.mockClear();

      applyCanvasMutation(store, canvasId, { type: 'selectView', viewId });

      expect(store.getState().selectedViewId).toBe(viewId);
      expect(broadcastSpy).toHaveBeenCalledTimes(1);
    });

    it('applies selectView with null to deselect', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      store.getState().selectView(viewId);
      broadcastSpy.mockClear();

      applyCanvasMutation(store, canvasId, { type: 'selectView', viewId: null });

      expect(store.getState().selectedViewId).toBeNull();
    });

    it('broadcasts selectedViewId in snapshot', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 0, y: 0 });
      store.getState().selectView(viewId);
      broadcastSpy.mockClear();

      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.selectedViewId).toBe(viewId);
    });

    it('broadcasts null selectedViewId when nothing is selected', () => {
      const canvasId = store.getState().activeCanvasId;
      broadcastCanvasState(store, canvasId);

      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.selectedViewId).toBeNull();
    });
  });

  describe('hydrateFromRemote selectedViewId sync', () => {
    it('takes selectedViewId from satellite on hydration', () => {
      const canvasId = 'remote-sel-1';

      store.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Tab 1', views: [
            { id: 'v1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
          ],
          viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
          zoomedViewId: null, selectedViewId: 'v1',
        }],
        canvasId,
      );

      expect(store.getState().selectedViewId).toBe('v1');
    });

    it('preserves local selectedViewId when satellite sends null', () => {
      const canvasId = 'remote-sel-2';

      // Initial hydration — select a view locally
      store.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Tab 1', views: [
            { id: 'v1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
          ],
          viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
          zoomedViewId: null, selectedViewId: 'v1',
        }],
        canvasId,
      );
      expect(store.getState().selectedViewId).toBe('v1');

      // Re-hydration without selectedViewId — should keep local
      store.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Tab 1', views: [
            { id: 'v1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
          ],
          viewport: { panX: 0, panY: 0, zoom: 1 }, nextZIndex: 1,
          zoomedViewId: null,
        }],
        canvasId,
      );

      expect(store.getState().selectedViewId).toBe('v1');
    });

    it('selectView round-trips through satellite', () => {
      const canvasId = 'round-trip-sel';

      // Satellite has a view
      const satelliteStore = createCanvasStore();
      satelliteStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{ id: 'cv_v1', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} }],
        }],
        canvasId,
      );

      // Controller sends selectView
      applyCanvasMutation(
        satelliteStore, canvasId,
        { type: 'selectView', viewId: 'cv_v1' },
        'proj-1', 'project',
      );

      expect(satelliteStore.getState().selectedViewId).toBe('cv_v1');

      // Broadcast includes selectedViewId
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.selectedViewId).toBe('cv_v1');

      // Controller hydrates from broadcast
      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: snapshot.canvasId, name: snapshot.name, views: snapshot.views,
          viewport: snapshot.viewport, nextZIndex: snapshot.nextZIndex,
          zoomedViewId: snapshot.zoomedViewId,
          selectedViewId: snapshot.selectedViewId,
        }],
        snapshot.activeCanvasId,
      );

      expect(controllerStore.getState().selectedViewId).toBe('cv_v1');
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

  // ── Controller optimistic local apply ──────────────────────────────
  //
  // The controller applies mutations locally AND forwards to satellite.
  // On hydration the satellite's state replaces the optimistic local state.

  describe('controller optimistic apply with satellite hydration', () => {
    it('addView appears locally then survives hydration with satellite version', () => {
      const canvasId = 'opt-canvas-1';

      // Controller hydrated from satellite
      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 0, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [],
        }],
        canvasId,
      );

      // Controller adds view locally (optimistic)
      controllerStore.getState().addView('agent', { x: 200, y: 200 });
      expect(controllerStore.getState().views).toHaveLength(1);
      const localViewId = controllerStore.getState().views[0].id;

      // Satellite processes the same mutation with a different view ID
      // and broadcasts back. Controller hydrates with satellite's version.
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_satellite1', type: 'agent',
            position: { x: 200, y: 200 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      // After hydration: satellite's version replaces local
      expect(controllerStore.getState().views).toHaveLength(1);
      expect(controllerStore.getState().views[0].id).toBe('cv_satellite1');
      expect(controllerStore.getState().views[0].id).not.toBe(localViewId);
    });

    it('moveView applies locally and survives hydration', () => {
      const canvasId = 'opt-canvas-2';

      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_view1', type: 'agent',
            position: { x: 100, y: 100 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      // Controller moves view locally (optimistic)
      controllerStore.getState().moveView('cv_view1', { x: 500, y: 300 });
      expect(controllerStore.getState().views[0].position).toEqual({ x: 500, y: 300 });

      // Satellite confirms the same move
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_view1', type: 'agent',
            position: { x: 500, y: 300 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      // Position stays at moved location (no snap-back)
      expect(controllerStore.getState().views[0].position).toEqual({ x: 500, y: 300 });
    });

    it('updateView (agent pick) applies locally — shows terminal immediately', () => {
      const canvasId = 'opt-canvas-3';

      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_view1', type: 'agent',
            position: { x: 100, y: 100 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      // Controller picks an agent (optimistic local apply)
      controllerStore.getState().updateView('cv_view1', {
        agentId: 'remote||sat-1||agent-1',
        title: 'mega-camel',
        displayName: 'mega-camel',
      });

      // View should immediately have agentId set (UI transitions to terminal)
      const view = controllerStore.getState().views[0] as any;
      expect(view.agentId).toBe('remote||sat-1||agent-1');
      expect(view.title).toBe('mega-camel');
    });

    it('removeView applies locally — view disappears immediately', () => {
      const canvasId = 'opt-canvas-4';

      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 2, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [
            { id: 'cv_a', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
            { id: 'cv_b', type: 'agent', position: { x: 500, y: 0 }, size: { width: 480, height: 480 }, title: 'B', displayName: 'B', zIndex: 1, metadata: {} },
          ],
        }],
        canvasId,
      );

      // Controller removes view B (optimistic)
      controllerStore.getState().removeView('cv_b');
      expect(controllerStore.getState().views).toHaveLength(1);
      expect(controllerStore.getState().views[0].id).toBe('cv_a');

      // Satellite confirms
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 2, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [
            { id: 'cv_a', type: 'agent', position: { x: 0, y: 0 }, size: { width: 480, height: 480 }, title: 'A', displayName: 'A', zIndex: 0, metadata: {} },
          ],
        }],
        canvasId,
      );

      expect(controllerStore.getState().views).toHaveLength(1);
    });

    it('resizeView applies locally — no snap-back on hydration', () => {
      const canvasId = 'opt-canvas-5';

      const controllerStore = createCanvasStore();
      controllerStore.getState().hydrateFromRemote(
        [{
          id: canvasId, name: 'Main', nextZIndex: 1, zoomedViewId: null,
          viewport: { panX: 0, panY: 0, zoom: 1 },
          views: [{
            id: 'cv_view1', type: 'agent',
            position: { x: 100, y: 100 }, size: { width: 480, height: 480 },
            title: 'Agent', displayName: 'Agent', zIndex: 0, metadata: {},
          }],
        }],
        canvasId,
      );

      controllerStore.getState().resizeView('cv_view1', { width: 800, height: 600 });
      expect(controllerStore.getState().views[0].size).toEqual({ width: 800, height: 600 });
    });
  });
});
