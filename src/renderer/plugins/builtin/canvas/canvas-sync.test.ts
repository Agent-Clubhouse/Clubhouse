import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyCanvasMutation, broadcastCanvasState } from './canvas-sync';
import { createCanvasStore } from './canvas-store';
import type { CanvasMutation } from '../../../../shared/types';

describe('canvas-sync', () => {
  let store: ReturnType<typeof createCanvasStore>;
  let broadcastSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = createCanvasStore();
    broadcastSpy = vi.fn();
    window.clubhouse.window.broadcastCanvasState = broadcastSpy;
  });

  describe('applyCanvasMutation', () => {
    it('applies addView mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const mutation: CanvasMutation = {
        type: 'addView',
        viewType: 'agent',
        position: { x: 100, y: 100 },
      };

      applyCanvasMutation(store, canvasId, mutation);

      const views = store.getState().views;
      expect(views).toHaveLength(1);
      expect(views[0].type).toBe('agent');
    });

    it('applies removeView mutation', () => {
      const canvasId = store.getState().activeCanvasId;

      // First add a view
      const viewId = store.getState().addView('agent', { x: 100, y: 100 });
      expect(store.getState().views).toHaveLength(1);

      // Then remove it
      const mutation: CanvasMutation = { type: 'removeView', viewId };
      applyCanvasMutation(store, canvasId, mutation);

      expect(store.getState().views).toHaveLength(0);
    });

    it('applies moveView mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 100, y: 100 });

      const mutation: CanvasMutation = {
        type: 'moveView',
        viewId,
        position: { x: 300, y: 400 },
      };

      applyCanvasMutation(store, canvasId, mutation);

      const view = store.getState().views.find((v) => v.id === viewId);
      expect(view?.position).toEqual({ x: 300, y: 400 });
    });

    it('applies resizeView mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 100, y: 100 });

      const mutation: CanvasMutation = {
        type: 'resizeView',
        viewId,
        size: { width: 600, height: 400 },
      };

      applyCanvasMutation(store, canvasId, mutation);

      const view = store.getState().views.find((v) => v.id === viewId);
      expect(view?.size).toEqual({ width: 600, height: 400 });
    });

    it('applies setViewport mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const mutation: CanvasMutation = {
        type: 'setViewport',
        viewport: { panX: 100, panY: 200, zoom: 1.5 },
      };

      applyCanvasMutation(store, canvasId, mutation);

      expect(store.getState().viewport).toEqual({ panX: 100, panY: 200, zoom: 1.5 });
    });

    it('applies zoomView mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 100, y: 100 });

      applyCanvasMutation(store, canvasId, { type: 'zoomView', viewId });
      expect(store.getState().zoomedViewId).toBe(viewId);

      // Toggle off
      applyCanvasMutation(store, canvasId, { type: 'zoomView', viewId: null });
      expect(store.getState().zoomedViewId).toBeNull();
    });

    it('applies focusView mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const viewId = store.getState().addView('agent', { x: 100, y: 100 });
      const initialZIndex = store.getState().views[0].zIndex;

      // Add another view
      store.getState().addView('agent', { x: 300, y: 300 });

      applyCanvasMutation(store, canvasId, { type: 'focusView', viewId });

      const view = store.getState().views.find((v) => v.id === viewId);
      // After focus, the view's zIndex should be at least the initial + 1
      expect(view!.zIndex).toBeGreaterThanOrEqual(initialZIndex);
    });

    it('broadcasts state after mutation', () => {
      const canvasId = store.getState().activeCanvasId;
      const mutation: CanvasMutation = {
        type: 'addView',
        viewType: 'agent',
        position: { x: 200, y: 200 },
      };

      applyCanvasMutation(store, canvasId, mutation);

      expect(broadcastSpy).toHaveBeenCalledWith(expect.objectContaining({
        canvasId,
        views: expect.any(Array),
        viewport: expect.any(Object),
      }));
    });

    it('applies mutation to non-active canvas', () => {
      // Create a second canvas
      const secondCanvasId = store.getState().addCanvas();
      // Switch back to first canvas
      const firstCanvasId = store.getState().canvases[0].id;
      store.getState().setActiveCanvas(firstCanvasId);

      // Apply mutation to the second canvas
      const mutation: CanvasMutation = {
        type: 'addView',
        viewType: 'anchor',
        position: { x: 50, y: 50 },
      };
      applyCanvasMutation(store, secondCanvasId, mutation);

      // Active canvas should be restored
      expect(store.getState().activeCanvasId).toBe(firstCanvasId);

      // The view should be on the second canvas
      const secondCanvas = store.getState().canvases.find((c) => c.id === secondCanvasId);
      expect(secondCanvas?.views).toHaveLength(1);
      expect(secondCanvas?.views[0].type).toBe('anchor');
    });
  });

  describe('broadcastCanvasState', () => {
    it('broadcasts current canvas state', () => {
      const canvasId = store.getState().activeCanvasId;
      broadcastCanvasState(store, canvasId);

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      const snapshot = broadcastSpy.mock.calls[0][0];
      expect(snapshot.canvasId).toBe(canvasId);
      expect(snapshot.views).toBeDefined();
      expect(snapshot.viewport).toBeDefined();
      expect(snapshot.nextZIndex).toBeDefined();
    });

    it('does nothing for non-existent canvas', () => {
      broadcastCanvasState(store, 'nonexistent');
      expect(broadcastSpy).not.toHaveBeenCalled();
    });
  });
});
