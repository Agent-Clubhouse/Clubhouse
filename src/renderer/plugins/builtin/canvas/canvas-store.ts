import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateHubName } from '../../../../shared/name-generator';
import type { CanvasView, CanvasViewType, CanvasInstance, CanvasInstanceData, Position, Size, Viewport } from './canvas-types';
import {
  createViewCounter,
  syncCounterToViews,
  createView as createViewOp,
  removeView as removeViewOp,
  updateViewPosition as updateViewPosOp,
  updateViewSize as updateViewSizeOp,
  updateViewTitle as updateViewTitleOp,
  bringToFront as bringToFrontOp,
  clampViewport,
  createCanvasCounter,
  generateCanvasId,
  syncCounterToInstances,
  type ViewCounter,
  type CanvasCounter,
} from './canvas-operations';

// ── Store state ──────────────────────────────────────────────────────

export interface CanvasState {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  loaded: boolean;

  // Lifecycle
  loadCanvas: (storage: ScopedStorage) => Promise<void>;
  saveCanvas: (storage: ScopedStorage) => Promise<void>;

  // Canvas tab management
  addCanvas: () => string;
  removeCanvas: (canvasId: string) => void;
  renameCanvas: (canvasId: string, name: string) => void;
  setActiveCanvas: (canvasId: string) => void;

  // View operations (on active canvas)
  addView: (type: CanvasViewType, position: Position) => string;
  removeView: (viewId: string) => void;
  moveView: (viewId: string, position: Position) => void;
  resizeView: (viewId: string, size: Size) => void;
  renameView: (viewId: string, title: string) => void;
  focusView: (viewId: string) => void;
  updateView: (viewId: string, updates: Partial<CanvasView>) => void;

  // Viewport
  setViewport: (viewport: Viewport) => void;

  // Zoom (temporary full-screen for a single view)
  zoomView: (viewId: string | null) => void;

  // Convenience selectors
  activeCanvas: () => CanvasInstance;
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
}

// ── Storage keys ─────────────────────────────────────────────────────

const STORAGE_KEY_INSTANCES = 'canvas-instances';
const STORAGE_KEY_ACTIVE = 'canvas-active-id';

// ── Helpers ──────────────────────────────────────────────────────────

function createCanvasInstance(canvasCounter: CanvasCounter, _viewCounter: ViewCounter): CanvasInstance {
  return {
    id: generateCanvasId(canvasCounter),
    name: generateHubName(),
    views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0,
    zoomedViewId: null,
  };
}

function updateActiveCanvas(state: CanvasState, updater: (canvas: CanvasInstance) => Partial<CanvasInstance>): Partial<CanvasState> {
  const canvases = state.canvases.map((c) => {
    if (c.id !== state.activeCanvasId) return c;
    return { ...c, ...updater(c) };
  });
  const active = canvases.find((c) => c.id === state.activeCanvasId)!;
  return {
    canvases,
    views: active.views,
    viewport: active.viewport,
    zoomedViewId: active.zoomedViewId,
  };
}

function syncDerivedState(canvases: CanvasInstance[], activeCanvasId: string): Pick<CanvasState, 'views' | 'viewport' | 'zoomedViewId'> {
  const active = canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  return {
    views: active.views,
    viewport: active.viewport,
    zoomedViewId: active.zoomedViewId,
  };
}

// ── Store factory ────────────────────────────────────────────────────

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasState>> {
  const viewCounter = createViewCounter();
  const canvasCounter = createCanvasCounter();
  const initialCanvas = createCanvasInstance(canvasCounter, viewCounter);

  return create<CanvasState>((set, get) => ({
    canvases: [initialCanvas],
    activeCanvasId: initialCanvas.id,
    views: initialCanvas.views,
    viewport: initialCanvas.viewport,
    zoomedViewId: null,
    loaded: false,

    activeCanvas: () => {
      const state = get();
      return state.canvases.find((c) => c.id === state.activeCanvasId) ?? state.canvases[0];
    },

    // ── Lifecycle ──────────────────────────────────────────────────

    loadCanvas: async (storage) => {
      try {
        const savedInstances = await storage.read(STORAGE_KEY_INSTANCES) as CanvasInstanceData[] | null;
        if (savedInstances && Array.isArray(savedInstances) && savedInstances.length > 0) {
          const canvases: CanvasInstance[] = savedInstances.map((s): CanvasInstance => {
            syncCounterToViews(s.views, viewCounter);
            return {
              id: s.id,
              name: s.name,
              views: s.views,
              viewport: clampViewport(s.viewport),
              nextZIndex: s.nextZIndex,
              zoomedViewId: s.zoomedViewId ?? null,
            };
          });
          syncCounterToInstances(canvases, canvasCounter);

          const savedActive = await storage.read(STORAGE_KEY_ACTIVE) as string | null;
          const activeCanvasId = (savedActive && canvases.find((c) => c.id === savedActive))
            ? savedActive
            : canvases[0].id;

          set({ canvases, activeCanvasId, loaded: true, ...syncDerivedState(canvases, activeCanvasId) });
          return;
        }

        // Fresh start
        const canvas = createCanvasInstance(canvasCounter, viewCounter);
        set({ canvases: [canvas], activeCanvasId: canvas.id, loaded: true, ...syncDerivedState([canvas], canvas.id) });
      } catch {
        const canvas = createCanvasInstance(canvasCounter, viewCounter);
        set({ canvases: [canvas], activeCanvasId: canvas.id, loaded: true, ...syncDerivedState([canvas], canvas.id) });
      }
    },

    saveCanvas: async (storage) => {
      const { canvases, activeCanvasId } = get();
      const data: CanvasInstanceData[] = canvases.map((c) => ({
        id: c.id,
        name: c.name,
        views: c.views,
        viewport: c.viewport,
        nextZIndex: c.nextZIndex,
      }));
      await storage.write(STORAGE_KEY_INSTANCES, data);
      await storage.write(STORAGE_KEY_ACTIVE, activeCanvasId);
    },

    // ── Canvas tab management ────────────────────────────────────

    addCanvas: () => {
      const canvas = createCanvasInstance(canvasCounter, viewCounter);
      const canvases = [...get().canvases, canvas];
      set({ canvases, activeCanvasId: canvas.id, ...syncDerivedState(canvases, canvas.id) });
      return canvas.id;
    },

    removeCanvas: (canvasId) => {
      const { canvases, activeCanvasId } = get();
      if (canvases.length <= 1) {
        const fresh = createCanvasInstance(canvasCounter, viewCounter);
        set({ canvases: [fresh], activeCanvasId: fresh.id, ...syncDerivedState([fresh], fresh.id) });
        return;
      }
      const filtered = canvases.filter((c) => c.id !== canvasId);
      const newActive = activeCanvasId === canvasId ? filtered[0].id : activeCanvasId;
      set({ canvases: filtered, activeCanvasId: newActive, ...syncDerivedState(filtered, newActive) });
    },

    renameCanvas: (canvasId, name) => {
      const canvases = get().canvases.map((c) => c.id === canvasId ? { ...c, name } : c);
      set({ canvases });
    },

    setActiveCanvas: (canvasId) => {
      const { canvases } = get();
      if (canvases.find((c) => c.id === canvasId)) {
        set({ activeCanvasId: canvasId, ...syncDerivedState(canvases, canvasId) });
      }
    },

    // ── View operations (active canvas) ──────────────────────────

    addView: (type, position) => {
      let newViewId = '';
      set(updateActiveCanvas(get(), (canvas) => {
        const view = createViewOp(type, position, canvas.nextZIndex, viewCounter);
        newViewId = view.id;
        return {
          views: [...canvas.views, view],
          nextZIndex: canvas.nextZIndex + 1,
        };
      }));
      return newViewId;
    },

    removeView: (viewId) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: removeViewOp(canvas.views, viewId),
      })));
    },

    moveView: (viewId, position) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: updateViewPosOp(canvas.views, viewId, position),
      })));
    },

    resizeView: (viewId, size) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: updateViewSizeOp(canvas.views, viewId, size),
      })));
    },

    renameView: (viewId, title) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: updateViewTitleOp(canvas.views, viewId, title),
      })));
    },

    focusView: (viewId) => {
      set(updateActiveCanvas(get(), (canvas) => {
        const result = bringToFrontOp(canvas.views, viewId, canvas.nextZIndex);
        return {
          views: result.views,
          nextZIndex: result.nextZIndex,
        };
      }));
    },

    updateView: (viewId, updates) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: canvas.views.map((v) =>
          v.id === viewId ? { ...v, ...updates } as CanvasView : v
        ),
      })));
    },

    // ── Viewport ─────────────────────────────────────────────────

    setViewport: (viewport) => {
      set(updateActiveCanvas(get(), () => ({
        viewport: clampViewport(viewport),
      })));
    },

    // ── Zoom ──────────────────────────────────────────────────────

    zoomView: (viewId) => {
      set(updateActiveCanvas(get(), () => ({
        zoomedViewId: viewId,
      })));
    },
  }));
}
