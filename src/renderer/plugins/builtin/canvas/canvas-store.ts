import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateHubName } from '../../../../shared/name-generator';
import type { CanvasView, CanvasViewType, CanvasInstance, CanvasInstanceData, AgentCanvasView, ZoneCanvasView, Position, Size, Viewport } from './canvas-types';
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
  recomputeZones,
} from './canvas-operations';

// ── Store state ──────────────────────────────────────────────────────

export interface CanvasState {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  loaded: boolean;
  /** True once wireDefinitions have been restored from storage.  The auto-save
   *  effect must not fire until this is set, otherwise a debounced save can
   *  overwrite persisted wires with the initial empty array. */
  wiresLoaded: boolean;

  // Lifecycle
  loadCanvas: (storage: ScopedStorage) => Promise<void>;
  saveCanvas: (storage: ScopedStorage) => Promise<void>;
  hydrateFromRemote: (canvasData: unknown[], activeCanvasId: string, wireDefinitions?: unknown[]) => void;

  // Wire persistence — wireDefinitions is the canvas-owned source of truth for
  // wires, independent of the MCP binding runtime.  Wires survive agent sleep
  // because definitions are not removed when the main process cleans up bindings.
  wireDefinitions: McpBindingEntry[];
  loadWires: (storage: ScopedStorage) => Promise<void>;
  saveWires: (storage: ScopedStorage) => Promise<void>;
  addWireDefinition: (entry: McpBindingEntry) => void;
  removeWireDefinition: (agentId: string, targetId: string) => void;
  updateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => void;

  // Canvas tab management
  addCanvas: () => string;
  insertCanvas: (canvas: CanvasInstance) => void;
  /** Load existing canvases from storage (if not loaded), insert a new canvas, and persist immediately. */
  loadAndInsertCanvas: (canvas: CanvasInstance, storage: ScopedStorage) => Promise<void>;
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

  // Zone operations
  removeZone: (zoneId: string, removeContents: boolean) => void;
  updateZoneTheme: (zoneId: string, themeId: string) => void;

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

  // Minimap auto-hide (per canvas, persisted)
  minimapAutoHide: boolean;
  setMinimapAutoHide: (value: boolean) => void;

  // Convenience selectors
  activeCanvas: () => CanvasInstance;
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  selectedViewId: string | null;

  // Note: minimapAutoHide is declared above with its setter
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
    minimapAutoHide: true,
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
    minimapAutoHide: active.minimapAutoHide,
  };
}

function syncDerivedState(canvases: CanvasInstance[], activeCanvasId: string): Pick<CanvasState, 'views' | 'viewport' | 'zoomedViewId' | 'selectedViewId' | 'minimapAutoHide'> {
  const active = canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  return {
    views: active.views,
    viewport: active.viewport,
    zoomedViewId: active.zoomedViewId,
    selectedViewId: active.selectedViewId,
    minimapAutoHide: active.minimapAutoHide,
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
    wireDefinitions: [],
    minimapAutoHide: true,
    loaded: false,
    wiresLoaded: false,

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
                ...(v.type === 'zone' ? { containedViewIds: v.containedViewIds ?? [] } : {}),
              })) as CanvasView[];
            return {
              id: s.id,
              name: s.name,
              views: restoredViews,
              viewport: clampViewport(s.viewport),
              nextZIndex: s.nextZIndex,
              zoomedViewId: s.zoomedViewId ?? null,
              selectedViewId: null,
              minimapAutoHide: s.minimapAutoHide ?? true,
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
        minimapAutoHide: c.minimapAutoHide,
      }));
      await storage.write(STORAGE_KEY_INSTANCES, data);
      await storage.write(STORAGE_KEY_ACTIVE, activeCanvasId);
    },

    loadWires: async (storage) => {
      try {
        const saved = await storage.read(STORAGE_KEY_WIRES) as McpBindingEntry[] | null;
        if (!saved || !Array.isArray(saved) || saved.length === 0) {
          set({ wiresLoaded: true });
          return;
        }

        // Build a set of valid IDs from all canvas views for reconciliation.
        // Bindings reference agentIds (durable_*/quick_*), groupProjectIds,
        // or browser widget view IDs — collect them all.
        const allViews = get().canvases.flatMap((c) => c.views);
        const validIds = new Set<string>();
        for (const v of allViews) {
          validIds.add(v.id);
          if (v.type === 'agent' && (v as AgentCanvasView).agentId) {
            validIds.add((v as AgentCanvasView).agentId!);
          }
          const gpId = v.metadata?.groupProjectId as string | undefined;
          if (gpId) validIds.add(gpId);
        }
        // Only reconcile if there are views to compare against — if the canvas
        // is empty, agents may not have been added yet (fresh session).
        const shouldReconcile = validIds.size > 0;

        // Restore each binding, skipping stale ones whose source/target no longer exist.
        // Wire definitions are stored in the canvas store so they survive agent
        // sleep/wake cycles independently of the MCP binding runtime.
        const restoredDefinitions: McpBindingEntry[] = [];
        for (const entry of saved) {
          if (!entry.agentId || !entry.targetId || !entry.label || !entry.targetKind) continue;
          if (shouldReconcile && !validIds.has(entry.agentId) && !validIds.has(entry.targetId)) continue;
          restoredDefinitions.push(entry);
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
            // Restore disabled tools if present
            if (entry.disabledTools && entry.disabledTools.length > 0) {
              await window.clubhouse.mcpBinding.setDisabledTools(entry.agentId, entry.targetId, entry.disabledTools);
            }
          } catch {
            // Binding restore failed (e.g. MCP not enabled or agent sleeping) —
            // keep the wire definition so the wire remains visible and persisted
          }
        }
        set({ wireDefinitions: restoredDefinitions, wiresLoaded: true });
      } catch {
        // Storage read failed — skip wire restore, but mark as loaded so
        // auto-save is not permanently blocked.
        set({ wiresLoaded: true });
      }
    },

    saveWires: async (storage) => {
      // Persist wire definitions — the canvas-owned source of truth.
      // Unlike MCP bindings, wire definitions are not cleared when agents sleep.
      const data = get().wireDefinitions.map((b) => ({
        agentId: b.agentId,
        targetId: b.targetId,
        targetKind: b.targetKind,
        label: b.label,
        agentName: b.agentName,
        targetName: b.targetName,
        projectName: b.projectName,
        ...(b.instructions ? { instructions: b.instructions } : {}),
        ...(b.disabledTools && b.disabledTools.length > 0 ? { disabledTools: b.disabledTools } : {}),
      }));
      await storage.write(STORAGE_KEY_WIRES, data);
    },

    addWireDefinition: (entry) => {
      set((state) => {
        const exists = state.wireDefinitions.some(
          (w) => w.agentId === entry.agentId && w.targetId === entry.targetId,
        );
        if (exists) return state;
        return { wireDefinitions: [...state.wireDefinitions, entry] };
      });
    },

    removeWireDefinition: (agentId, targetId) => {
      set((state) => ({
        wireDefinitions: state.wireDefinitions.filter(
          (w) => !(w.agentId === agentId && w.targetId === targetId),
        ),
      }));
    },

    updateWireDefinition: (agentId, targetId, updates) => {
      set((state) => ({
        wireDefinitions: state.wireDefinitions.map((w) =>
          w.agentId === agentId && w.targetId === targetId
            ? { ...w, ...updates }
            : w,
        ),
      }));
    },

    hydrateFromRemote: (canvasData, activeId, remoteWireDefinitions?) => {
      if (!canvasData || !Array.isArray(canvasData) || canvasData.length === 0) return;
      const existingState = get();
      const existingCanvasMap = new Map(existingState.canvases.map((c) => [c.id, c]));

      const canvases: CanvasInstance[] = (canvasData as CanvasInstanceData[]).map((s): CanvasInstance => {
        const restoredViews = (s.views || []).map((v: any) => ({
          ...v,
          metadata: v.metadata ?? {},
          displayName: v.displayName ?? v.title ?? v.type ?? '',
        })) as CanvasView[];

        // Preserve local viewport when merging (controller keeps its own
        // pan/zoom position while receiving view updates from satellite).
        // Selection and zoom are synced from the satellite.
        const existing = existingCanvasMap.get(s.id);
        return {
          id: s.id,
          name: s.name,
          views: restoredViews,
          viewport: existing ? existing.viewport : clampViewport(s.viewport),
          nextZIndex: s.nextZIndex,
          zoomedViewId: s.zoomedViewId ?? null,
          selectedViewId: (s as any).selectedViewId ?? existing?.selectedViewId ?? null,
          minimapAutoHide: existing?.minimapAutoHide ?? s.minimapAutoHide ?? true,
        };
      });

      // Preserve the controller's active canvas tab if the user hasn't switched
      // on the satellite. Only follow satellite active tab on first hydration.
      const resolvedActive = existingState.loaded && existingState.canvases.length > 0
        ? (canvases.find((c) => c.id === existingState.activeCanvasId)
          ? existingState.activeCanvasId
          : (activeId && canvases.find((c) => c.id === activeId) ? activeId : canvases[0].id))
        : (activeId && canvases.find((c) => c.id === activeId) ? activeId : canvases[0].id);

      // Restore wire definitions from remote state if provided.
      // Wire definitions are already namespaced by the annex client handler.
      const wireUpdate = remoteWireDefinitions && Array.isArray(remoteWireDefinitions) && remoteWireDefinitions.length > 0
        ? { wireDefinitions: remoteWireDefinitions as McpBindingEntry[] }
        : {};

      set({ canvases, activeCanvasId: resolvedActive, loaded: true, wiresLoaded: true, ...wireUpdate, ...syncDerivedState(canvases, resolvedActive) });
    },

    // ── Canvas tab management ────────────────────────────────────

    addCanvas: () => {
      const canvas = createCanvasInstance();
      const canvases = [...get().canvases, canvas];
      set({ canvases, activeCanvasId: canvas.id, ...syncDerivedState(canvases, canvas.id) });
      return canvas.id;
    },

    insertCanvas: (canvas) => {
      const canvases = [...get().canvases, canvas];
      set({ canvases, activeCanvasId: canvas.id, ...syncDerivedState(canvases, canvas.id) });
    },

    loadAndInsertCanvas: async (canvas, storage) => {
      // Ensure existing canvases are loaded from disk first
      if (!get().loaded) {
        await get().loadCanvas(storage);
      }
      // Insert the new canvas
      const canvases = [...get().canvases, canvas];
      set({ canvases, activeCanvasId: canvas.id, loaded: true, ...syncDerivedState(canvases, canvas.id) });
      // Persist immediately so the canvas survives re-mounts
      await get().saveCanvas(storage);
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
        const newViews = [...canvas.views, view];
        return {
          // When adding a zone, skip recomputeZones so existing agents aren't
          // auto-contained. The zone starts empty; agents join when moved in.
          views: type === 'zone' ? newViews : recomputeZones(newViews),
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
          views: recomputeZones([...canvas.views, view]),
          nextZIndex: canvas.nextZIndex + 1,
        };
      }));
      return newViewId;
    },

    removeView: (viewId) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(removeViewOp(canvas.views, viewId)),
        selectedViewId: canvas.selectedViewId === viewId ? null : canvas.selectedViewId,
      })));
    },

    moveView: (viewId, position) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(updateViewPosOp(canvas.views, viewId, position)),
      })));
    },

    resizeView: (viewId, size) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(updateViewSizeOp(canvas.views, viewId, size)),
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

    // ── Zone operations ─────────────────────────────────────────

    removeZone: (zoneId, removeContents) => {
      set(updateActiveCanvas(get(), (canvas) => {
        const zone = canvas.views.find((v) => v.id === zoneId && v.type === 'zone') as ZoneCanvasView | undefined;
        if (!zone) return { views: canvas.views };

        let views = canvas.views.filter((v) => v.id !== zoneId);
        if (removeContents) {
          const contained = new Set(zone.containedViewIds);
          views = views.filter((v) => !contained.has(v.id));
        }
        return {
          views: recomputeZones(views),
          selectedViewId: canvas.selectedViewId === zoneId ? null : canvas.selectedViewId,
        };
      }));
    },

    updateZoneTheme: (zoneId, themeId) => {
      set(updateActiveCanvas(get(), (canvas) => ({
        views: canvas.views.map((v) =>
          v.id === zoneId && v.type === 'zone'
            ? { ...v, themeId } as ZoneCanvasView
            : v,
        ),
      })));
    },

    // ── Viewport ─────────────────────────────────────────────────

    setViewport: (viewport) => {
      set(updateActiveCanvas(get(), () => ({
        viewport: clampViewport(viewport),
      })));
    },

    // ── Minimap auto-hide ─────────────────────────────────────────

    setMinimapAutoHide: (value) => {
      set(updateActiveCanvas(get(), () => ({
        minimapAutoHide: value,
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
        views: recomputeZones(canvas.views.map((v) => {
          const newPos = positions.get(v.id);
          return newPos ? { ...v, position: clampPosition(newPos) } : v;
        })),
      })));
    },
  }));
}
