/**
 * Canvas state synchronisation between main window (leader) and pop-out
 * windows (followers), as well as annex controller ↔ satellite sync.
 *
 * The main window's canvas stores (per-project via `getProjectCanvasStore()` /
 * `useAppCanvasStore`) are the single source of truth.  Pop-outs and annex
 * controllers forward mutations here; this module applies them and broadcasts
 * the resulting state to all pop-out windows and annex clients via IPC.
 */
import type { StoreApi, UseBoundStore } from 'zustand';
import type { CanvasState } from './canvas-store';
import type { CanvasMutation, CanvasStateSnapshot } from '../../../../shared/types';
import type { CanvasView, CanvasViewType } from './canvas-types';
import { parseNamespacedId } from '../../../stores/remoteProjectStore';

/**
 * Apply a mutation forwarded from a pop-out window or annex controller
 * to the correct canvas instance in the given store, then broadcast
 * the updated state.
 *
 * `projectId` and `scope` are included in the broadcast so that the main
 * process can forward state changes to annex controller clients.  Without
 * them the main-process gate (`if (state.projectId)`) silently drops the
 * update and the controller never sees the result of the mutation.
 */
export function applyCanvasMutation(
  store: UseBoundStore<StoreApi<CanvasState>>,
  canvasId: string,
  mutation: CanvasMutation,
  projectId?: string,
  scope?: string,
): void {
  // Handle store-level mutations (no canvas switching needed)
  switch (mutation.type) {
    case 'addCanvas':
      store.getState().addCanvas();
      broadcastCanvasState(store, store.getState().activeCanvasId, projectId, scope);
      return;
    case 'removeCanvas':
      store.getState().removeCanvas(mutation.canvasId);
      broadcastCanvasState(store, store.getState().activeCanvasId, projectId, scope);
      return;
    case 'renameCanvas':
      store.getState().renameCanvas(mutation.canvasId, mutation.name);
      broadcastCanvasState(store, store.getState().activeCanvasId, projectId, scope);
      return;
    case 'setActiveCanvas':
      store.getState().setActiveCanvas(mutation.canvasId);
      broadcastCanvasState(store, mutation.canvasId, projectId, scope);
      return;
  }

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
    case 'moveViews': {
      const posMap = new Map(Object.entries(mutation.positions));
      store.getState().moveViews(posMap);
      break;
    }
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

  // Broadcast updated state to pop-out windows and annex clients
  broadcastCanvasState(store, canvasId, projectId, scope);
}

/**
 * Broadcast the current state of a canvas instance to all pop-out windows
 * (and, via the main process, to annex controller clients).
 *
 * Includes tab metadata so annex controllers can sync the full tab list.
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
    // Tab metadata for annex controllers
    allCanvasTabs: state.canvases.map((c) => ({ id: c.id, name: c.name })),
    activeCanvasId: state.activeCanvasId,
  };

  window.clubhouse.window.broadcastCanvasState(snapshot);
}

/**
 * Forward a canvas mutation to a satellite via the annex client.
 * Used when the controller user interacts with a remote canvas.
 */
export function sendRemoteCanvasMutation(
  projectId: string,
  canvasId: string,
  scope: string,
  mutation: CanvasMutation,
): void {
  const parsed = parseNamespacedId(projectId);
  if (!parsed) return;
  const { satelliteId, agentId: origProjectId } = parsed;
  window.clubhouse.annexClient.canvasMutation(
    satelliteId,
    origProjectId,
    canvasId,
    scope,
    mutation,
  );
}
