import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateHubName } from '../../../../shared/name-generator';
import type { CanvasView, CanvasViewType, CanvasInstance, CanvasInstanceData, Position, Size, Viewport } from './canvas-types';
import type { CanvasWidgetMetadata, CanvasWidgetFilter, CanvasWidgetHandle } from '../../../../shared/plugin-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import {
  createView as createViewOp,
  createPluginView as createPluginViewOp,
  removeView as removeViewOp,
  updateViewPosition as updateViewPosOp,
  updateViewSize as updateViewSizeOp,
  updateViewTitle as updateViewTitleOp,
  bringToFront as bringToFrontOp,
  clampViewport,
  clampPosition,
  queryViews as queryViewsOp,
  generateCanvasId,
} from './canvas-operations';

// ── Store state ──────────────────────────────────────────────────────

export interface CanvasState {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  loaded: boolean;

  // Lifecycle
  loadCanvas: (storage: ScopedStorage) => Promise<void>;
  saveCanvas: (storage: ScopedStorage) => Promise<void>;
  hydrateFromRemote: (canvasData: unknown[], activeCanvasId: string) => void;

  // Wire persistence
  loadWires: (storage: ScopedStorage) => Promise<void>;
  saveWires: (storage: ScopedStorage, bindings: McpBindingEntry[]) => Promise<void>;

  // Canvas tab management
  addCanvas: () => string;
  removeCanvas: (canvasId: string) => void;
  renameCanvas: (canvasId: string, name: string) => void;
  setActiveCanvas: (canvasId: string) => void;

  // View operations (on active canvas)
  addView: (type: CanvasViewType, position: Position) => string;
  addPluginView: (
    pluginId: string,
    pluginWidgetType: string,
    label: string,
    position: Position,
    metadata?: CanvasWidgetMetadata,
    defaultSize?: { width: number; height: number },
  ) => string;
  removeView: (viewId: string) => void;
  moveView: (viewId: string, position: Position) => void;
  resizeView: (viewId: string, size: Size) => void;
  renameView: (viewId: string, title: string) => void;
  focusView: (viewId: string) => void;
  updateView: (viewId: string, updates: Partial<CanvasView>) => void;
  updateViewMetadata: (viewId: string, metadataUpdates: CanvasWidgetMetadata) => void;
  queryViews: (filter?: CanvasWidgetFilter) => CanvasWidgetHandle[];

  // Viewport
  setViewport: (viewport: Viewport) => void;

  // Zoom (temporary full-screen for a single view)
  zoomView: (viewId: string | null) => void;

  // Selection (which view receives keyboard/scroll events)
  selectView: (viewId: string | null) => void;

  // Multi-selection (group operations: lasso, Cmd+click)
  selectedViewIds: string[];
  toggleSelectView: (viewId: string) => void;
  setSelectedViewIds: (ids: string[]) => void;
  clearSelection: () => void;
  moveViews: (positions: Map<string, Position>) => void;

  // Convenience selectors
  activeCanvas: () => CanvasInstance;
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  selectedViewId: string | null;
}

// ── Storage keys ─────────────────────────────────────────────────────

const STORAGE_KEY_INSTANCES = 'canvas-instances';
const STORAGE_KEY_ACTIVE = 'canvas-active-id';
const STORAGE_KEY_WIRES = 'canvas-wires';

// ── Helpers ──────────────────────────────────────────────────────────

function createCanvasInstance(): CanvasInstance {
  return {
    id: generateCanvasId(),
    name: generateHubName(),
    views: [],
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nextZIndex: 0,
    zoomedViewId: null,
    selectedViewId: null,
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
    selectedViewId: active.selectedViewId,
  };
}

function syncDerivedState(canvases: CanvasInstance[], activeCanvasId: string): Pick<CanvasState, 'views' | 'viewport' | 'zoomedViewId' | 'selectedViewId'> {
  const active = canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  return {
    views: active.views,
    viewport: active.viewport,
    zoomedViewId: active.zoomedViewId,
    selectedViewId: active.selectedViewId,
  };
}

// ── Store factory ────────────────────────────────────────────────────

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasState>> {
  const initialCanvas = createCanvasInstance();

  return create<CanvasState>((set, get) => ({
    canvases: [initialCanvas],
    activeCanvasId: initialCanvas.id,
    views: initialCanvas.views,
    viewport: initialCanvas.viewport,
    zoomedViewId: null,
    selectedViewId: null,
    selectedViewIds: [],
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
            // Backfill displayName and metadata for views saved in older formats.
            // Filter out legacy view types that no longer exist (browser, file,
            // legacy-file, terminal, legacy-terminal, git-diff, legacy-git-diff) —
            // these have been replaced by plugin-provided widgets.
            const REMOVED_TYPES = new Set(['browser', 'file', 'legacy-file', 'terminal', 'legacy-terminal', 'git-diff', 'legacy-git-diff']);
            const restoredViews = s.views
              .filter((v: any) => !REMOVED_TYPES.has(v.type))
              .map((v: any) => ({
                ...v,
                metadata: v.metadata ?? {},
                displayName: v.displayName ?? v.title ?? v.type ?? '',
              })) as CanvasView[];
            return {
              id: s.id,
              name: s.name,
              views: restoredViews,
              viewport: clampViewport(s.viewport),
              nextZIndex: s.nextZIndex,
              zoomedViewId: s.zoomedViewId ?? null,
              selectedViewId: null,
            };
          });
          const savedActive = await storage.read(STORAGE_KEY_ACTIVE) as string | null;
          const activeCanvasId = (savedActive && canvases.find((c) => c.id === savedActive))
            ? savedActive
            : canvases[0].id;

          set({ canvases, activeCanvasId, loaded: true, ...syncDerivedState(canvases, activeCanvasId) });
          return;
        }

        // Fresh start
        const canvas = createCanvasInstance();
        set({ canvases: [canvas], activeCanvasId: canvas.id, loaded: true, ...syncDerivedState([canvas], canvas.id) });
      } catch {
        const canvas = createCanvasInstance();
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

    loadWires: async (storage) => {
      try {
        const saved = await storage.read(STORAGE_KEY_WIRES) as McpBindingEntry[] | null;
        if (!saved || !Array.isArray(saved) || saved.length === 0) return;

        // Restore each binding to the main process
        for (const entry of saved) {
          if (!entry.agentId || !entry.targetId || !entry.label || !entry.targetKind) continue;
          try {
            await window.clubhouse.mcpBinding.bind(entry.agentId, {
              targetId: entry.targetId,
              targetKind: entry.targetKind,
              label: entry.label,
              agentName: entry.agentName,
              targetName: entry.targetName,
              projectName: entry.projectName,
            });
            // Restore instructions if present
            if (entry.instructions && Object.keys(entry.instructions).length > 0) {
              await window.clubhouse.mcpBinding.setInstructions(entry.agentId, entry.targetId, entry.instructions);
            }
          } catch {
            // Binding restore failed (e.g. MCP not enabled) — skip
          }
        }
      } catch {
        // Storage read failed — skip wire restore
      }
    },

    saveWires: async (storage, bindings) => {
      // Persist all binding entries including instructions
      const data = bindings.map((b) => ({
        agentId: b.agentId,
        targetId: b.targetId,
        targetKind: b.targetKind,
        label: b.label,
        agentName: b.agentName,
        targetName: b.targetName,
        projectName: b.projectName,
        ...(b.instructions ? { instructions: b.instructions } : {}),
      }));
      await storage.write(STORAGE_KEY_WIRES, data);
    },

    hydrateFromRemote: (canvasData, activeId) => {
      if (!canvasData || !Array.isArray(canvasData) || canvasData.length === 0) return;
      const canvases: CanvasInstance[] = (canvasData as CanvasInstanceData[]).map((s): CanvasInstance => {
        const restoredViews = (s.views || []).map((v: any) => ({
          ...v,
          metadata: v.metadata ?? {},
          displayName: v.displayName ?? v.title ?? v.type ?? '',
        })) as CanvasView[];
        return {
          id: s.id,
          name: s.name,
          views: restoredViews,
          viewport: clampViewport(s.viewport),
          nextZIndex: s.nextZIndex,
          zoomedViewId: s.zoomedViewId ?? null,
          selectedViewId: null,
        };
      });
      const resolvedActive = (activeId && canvases.find((c) => c.id === activeId))
        ? activeId
        : canvases[0].id;
      set({ canvases, activeCanvasId: resolvedActive, loaded: true, ...syncDerivedState(canvases, resolvedActive) });
    },

    // ── Canvas tab management ────────────────────────────────────

    addCanvas: () => {
      const canvas = createCanvasInstance();
      const canvases = [...get().canvases, canvas];
      set({ canvases, activeCanvasId: canvas.id, ...syncDerivedState(canvases, canvas.id) });
      return canvas.id;
    },

    removeCanvas: (canvasId) => {
      const { canvases, activeCanvasId } = get();
      if (canvases.length <= 1) {
        const fresh = createCanvasInstance();
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
        const existingNames = canvas.views.map((v) => v.displayName);
        const view = createViewOp(type, position, canvas.nextZIndex, existingNames);
        newViewId = view.id;
        return {
          views: [...canvas.views, view],
          nextZIndex: canvas.nextZIndex + 1,
        };
      }));
      return newViewId;
    },

    addPluginView: (pluginId, pluginWidgetType, label, position, metadata, defaultSize) => {
      let newViewId = '';
      set(updateActiveCanvas(get(), (canvas) => {
        const existingNames = canvas.views.map((v) => v.displayName);
        const view = createPluginViewOp(
          pluginId, pluginWidgetType, label, position,
          canvas.nextZIndex, existingNames, metadata ?? {}, defaultSize,
        );
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
        selectedViewId: canvas.selectedViewId === viewId ? null : canvas.selectedViewId,
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

    updateViewMetadata: (viewId, metadataUpdates) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: canvas.views.map((v) =>
          v.id === viewId
            ? { ...v, metadata: { ...v.metadata, ...metadataUpdates } } as CanvasView
            : v
        ),
      })));
    },

    queryViews: (filter?) => {
      const { views } = get();
      return queryViewsOp(views, filter);
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

    // ── Selection ────────────────────────────────────────────────

    selectView: (viewId) => {
      set(updateActiveCanvas(get(), (canvas) => {
        if (viewId === null) {
          return { selectedViewId: null };
        }
        // Also bring selected view to front
        const result = bringToFrontOp(canvas.views, viewId, canvas.nextZIndex);
        return {
          selectedViewId: viewId,
          views: result.views,
          nextZIndex: result.nextZIndex,
        };
      }));
    },

    // ── Multi-selection ──────────────────────────────────────────

    toggleSelectView: (viewId) => {
      const { selectedViewIds } = get();
      if (selectedViewIds.includes(viewId)) {
        set({ selectedViewIds: selectedViewIds.filter((id) => id !== viewId) });
      } else {
        set({ selectedViewIds: [...selectedViewIds, viewId] });
      }
    },

    setSelectedViewIds: (ids) => {
      set({ selectedViewIds: ids });
    },

    clearSelection: () => {
      set({ selectedViewIds: [], selectedViewId: null });
    },

    moveViews: (positions) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: canvas.views.map((v) => {
          const newPos = positions.get(v.id);
          return newPos ? { ...v, position: clampPosition(newPos) } : v;
        }),
      })));
    },
  }));
}
