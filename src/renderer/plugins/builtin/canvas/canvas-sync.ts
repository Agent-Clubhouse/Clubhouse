/**
 * Canvas state synchronisation between main window (leader) and pop-out
 * windows (followers).
 *
 * The main window's canvas stores (per-project via `getProjectCanvasStore()` /
 * `useAppCanvasStore`) are the single source of truth.  Pop-outs forward
 * mutations here; this module applies them and broadcasts the resulting state
 * to all pop-out windows via IPC.
 */
import type { StoreApi, UseBoundStore } from 'zustand';
import type { CanvasState } from './canvas-store';
import type { CanvasMutation, CanvasStateSnapshot } from '../../../../shared/types';
import type { CanvasView, CanvasViewType } from './canvas-types';

/**
 * Apply a mutation forwarded from a pop-out window to the correct canvas
 * instance in the given store, then broadcast the updated state.
 */
export function applyCanvasMutation(
  store: UseBoundStore<StoreApi<CanvasState>>,
  canvasId: string,
  mutation: CanvasMutation,
): void {
  const state = store.getState();

  // Temporarily switch to the target canvas if it's not the active one
  const prevActive = state.activeCanvasId;
  if (prevActive !== canvasId) {
    store.getState().setActiveCanvas(canvasId);
  }

  switch (mutation.type) {
    case 'addView':
      store.getState().addView(mutation.viewType as CanvasViewType, mutation.position);
      break;
    case 'addPluginView':
      store.getState().addPluginView(
        mutation.pluginId, mutation.qualifiedType, mutation.label,
        mutation.position, undefined, mutation.defaultSize,
      );
      break;
    case 'removeView':
      store.getState().removeView(mutation.viewId);
      break;
    case 'moveView':
      store.getState().moveView(mutation.viewId, mutation.position);
      break;
    case 'resizeView':
      store.getState().resizeView(mutation.viewId, mutation.size);
      break;
    case 'focusView':
      store.getState().focusView(mutation.viewId);
      break;
    case 'updateView':
      store.getState().updateView(mutation.viewId, mutation.updates as Partial<CanvasView>);
      break;
    case 'setViewport':
      store.getState().setViewport(mutation.viewport);
      break;
    case 'zoomView':
      store.getState().zoomView(mutation.viewId);
      break;
  }

  // Restore active canvas if we switched
  if (prevActive !== canvasId) {
    store.getState().setActiveCanvas(prevActive);
  }

  // Broadcast updated state to pop-out windows
  broadcastCanvasState(store, canvasId);
}

/**
 * Broadcast the current state of a canvas instance to all pop-out windows
 * (and, via the main process, to annex controller clients).
 */
export function broadcastCanvasState(
  store: UseBoundStore<StoreApi<CanvasState>>,
  canvasId: string,
  projectId?: string,
  scope?: string,
): void {
  const state = store.getState();
  const canvas = state.canvases.find((c) => c.id === canvasId);
  if (!canvas) return;

  const snapshot: CanvasStateSnapshot = {
    canvasId: canvas.id,
    name: canvas.name,
    views: canvas.views,
    viewport: canvas.viewport,
    nextZIndex: canvas.nextZIndex,
    zoomedViewId: canvas.zoomedViewId,
    projectId,
    scope,
  };

  window.clubhouse.window.broadcastCanvasState(snapshot);
}
