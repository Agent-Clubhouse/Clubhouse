import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateHubName } from '../../../../shared/name-generator';
import { rendererLog } from '../../renderer-logger';
import type { CanvasView, CanvasViewType, CanvasInstance, CanvasInstanceData, AgentCanvasView, ZoneCanvasView, Position, Size, Viewport } from './canvas-types';
import type { CanvasWidgetMetadata, CanvasWidgetFilter, CanvasWidgetHandle } from '../../../../shared/plugin-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { generateZoneWireId, type ZoneWireDefinition } from './zone-wire-store';
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
  hydrateFromRemote: (canvasData: unknown[], activeCanvasId: string, wireDefinitions?: unknown[], zoneWireDefinitions?: unknown[]) => void;

  // Wire persistence — wireDefinitions is the canvas-owned source of truth for
  // wires, independent of the MCP binding runtime.  Wires survive agent sleep
  // because definitions are not removed when the main process cleans up bindings.
  wireDefinitions: McpBindingEntry[];
  loadWires: (storage: ScopedStorage) => Promise<void>;
  saveWires: (storage: ScopedStorage) => Promise<void>;
  addWireDefinition: (entry: McpBindingEntry) => void;
  removeWireDefinition: (agentId: string, targetId: string) => void;
  updateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => void;

  // Zone wire persistence — zone wires are conceptual wires from a zone to a
  // target that expand into per-agent bindings. Persisted + synced alongside
  // wireDefinitions so they survive reload and the annex round-trip.
  zoneWireDefinitions: ZoneWireDefinition[];
  addZoneWireDefinition: (wire: Omit<ZoneWireDefinition, 'id'>) => ZoneWireDefinition;
  removeZoneWireDefinition: (wireId: string) => void;

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

  // ELK layout preferences (per canvas, persisted)
  elkAlgorithm: 'layered' | 'radial' | 'force' | 'mrtree';
  elkDirection: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP';
  layoutCenterId: string | null;
  setElkAlgorithm: (value: 'layered' | 'radial' | 'force' | 'mrtree') => void;
  setElkDirection: (value: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP') => void;
  setLayoutCenterId: (value: string | null) => void;

  // Convenience selectors
  activeCanvas: () => CanvasInstance;
  views: CanvasView[];
  viewport: Viewport;
  zoomedViewId: string | null;
  selectedViewId: string | null;
}

// ── Storage keys ─────────────────────────────────────────────────────

const STORAGE_KEY_INSTANCES = 'canvas-instances';
// Last-good backup of the instances written alongside the primary (see
// saveCanvas / loadCanvas). Guards against the primary file being torn by a
// crash mid-write, which otherwise loads as an empty canvas and gets
// overwritten on the next autosave — silently destroying all cards.
const STORAGE_KEY_INSTANCES_BACKUP = 'canvas-instances-backup';
const STORAGE_KEY_ACTIVE = 'canvas-active-id';
const STORAGE_KEY_WIRES = 'canvas-wires';
const STORAGE_KEY_ZONE_WIRES = 'canvas-zone-wires';

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
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
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
    elkAlgorithm: active.elkAlgorithm,
    elkDirection: active.elkDirection,
    layoutCenterId: active.layoutCenterId,
  };
}

function syncDerivedState(canvases: CanvasInstance[], activeCanvasId: string): Pick<CanvasState, 'views' | 'viewport' | 'zoomedViewId' | 'selectedViewId' | 'minimapAutoHide' | 'elkAlgorithm' | 'elkDirection' | 'layoutCenterId'> {
  const active = canvases.find((c) => c.id === activeCanvasId) ?? canvases[0];
  return {
    views: active.views,
    viewport: active.viewport,
    zoomedViewId: active.zoomedViewId,
    selectedViewId: active.selectedViewId,
    minimapAutoHide: active.minimapAutoHide,
    elkAlgorithm: active.elkAlgorithm,
    elkDirection: active.elkDirection,
    layoutCenterId: active.layoutCenterId,
  };
}

// ── Store factory ────────────────────────────────────────────────────

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasState>> {
  const initialCanvas = createCanvasInstance();
  let _wiresLoading = false;

  return create<CanvasState>((set, get) => ({
    canvases: [initialCanvas],
    activeCanvasId: initialCanvas.id,
    views: initialCanvas.views,
    viewport: initialCanvas.viewport,
    zoomedViewId: null,
    selectedViewId: null,
    selectedViewIds: [],
    wireDefinitions: [],
    zoneWireDefinitions: [],
    minimapAutoHide: true,
    elkAlgorithm: 'layered',
    elkDirection: 'RIGHT',
    layoutCenterId: null,
    loaded: false,
    wiresLoaded: false,

    activeCanvas: () => {
      const state = get();
      return state.canvases.find((c) => c.id === state.activeCanvasId) ?? state.canvases[0];
    },

    // ── Lifecycle ──────────────────────────────────────────────────

    loadCanvas: async (storage) => {
      try {
        // Restore zone wire definitions alongside the canvas. They expand into
        // bindings at runtime (no MCP state of their own), so they belong with
        // the canvas data rather than the MCP wire restore.
        let loadedZoneWires: ZoneWireDefinition[] = [];
        try {
          const savedZoneWires = await storage.read(STORAGE_KEY_ZONE_WIRES) as ZoneWireDefinition[] | null;
          if (savedZoneWires && Array.isArray(savedZoneWires)) {
            loadedZoneWires = savedZoneWires.filter(
              (w) => w && w.id && w.sourceZoneId && w.targetId && w.targetType,
            );
          }
        } catch {
          // ignore zone wire restore failure
        }

        let savedInstances = await storage.read(STORAGE_KEY_INSTANCES) as CanvasInstanceData[] | null;
        // A torn/corrupt primary reads back as null (parse failure → undefined)
        // or a non-array. Rather than fall through to a fresh empty canvas —
        // which the next autosave would then persist over the good data — try
        // the last-good backup first. A valid empty canvas is always a
        // non-empty array (≥1 instance), so this only triggers on real loss.
        if (!Array.isArray(savedInstances) || savedInstances.length === 0) {
          const backup = await storage.read(STORAGE_KEY_INSTANCES_BACKUP) as CanvasInstanceData[] | null;
          if (Array.isArray(backup) && backup.length > 0) {
            rendererLog('canvas', 'warn', 'Primary canvas data missing/corrupt — recovered from backup', {
              meta: { backupCanvases: backup.length },
            });
            savedInstances = backup;
          }
        }
        if (savedInstances && Array.isArray(savedInstances) && savedInstances.length > 0) {
          const canvases: CanvasInstance[] = savedInstances.map((s): CanvasInstance => {
            // Restore each instance defensively: a single partially-written or
            // malformed record must degrade to an empty-but-valid canvas, NOT
            // throw and send the outer catch into replacing ALL canvases with
            // one fresh empty canvas — that is the silent, total card-loss bug.
            try {
              // Backfill displayName and metadata for views saved in older
              // formats. Filter out legacy view types that no longer exist
              // (browser, file, legacy-file, terminal, legacy-terminal,
              // git-diff, legacy-git-diff) — replaced by plugin-provided widgets.
              const REMOVED_TYPES = new Set(['browser', 'file', 'legacy-file', 'terminal', 'legacy-terminal', 'git-diff', 'legacy-git-diff']);
              const restoredViews = (Array.isArray(s.views) ? s.views : [])
                .filter((v: any) => !REMOVED_TYPES.has(v.type))
                .map((v: any) => ({
                  ...v,
                  metadata: v.metadata ?? {},
                  displayName: v.displayName ?? v.title ?? v.type ?? '',
                  ...(v.type === 'zone' ? { containedViewIds: v.containedViewIds ?? [] } : {}),
                })) as CanvasView[];
              const rawViewport: Partial<Viewport> = (s.viewport && typeof s.viewport === 'object') ? s.viewport : {};
              return {
                id: s.id ?? generateCanvasId(),
                name: s.name ?? generateHubName(),
                views: restoredViews,
                viewport: clampViewport({
                  panX: rawViewport.panX ?? 0,
                  panY: rawViewport.panY ?? 0,
                  zoom: rawViewport.zoom ?? 1,
                }),
                nextZIndex: s.nextZIndex ?? restoredViews.length,
                zoomedViewId: s.zoomedViewId ?? null,
                selectedViewId: null,
                minimapAutoHide: s.minimapAutoHide ?? true,
                elkAlgorithm: s.elkAlgorithm ?? 'layered',
                elkDirection: s.elkDirection ?? 'RIGHT',
                layoutCenterId: s.layoutCenterId ?? null,
              };
            } catch (err) {
              rendererLog('canvas', 'error', 'Skipped malformed canvas instance on load', {
                meta: { id: s?.id, error: err instanceof Error ? err.message : String(err) },
              });
              return {
                id: s?.id ?? generateCanvasId(),
                name: s?.name ?? generateHubName(),
                views: [],
                viewport: { panX: 0, panY: 0, zoom: 1 },
                nextZIndex: 0,
                zoomedViewId: null,
                selectedViewId: null,
                minimapAutoHide: true,
                elkAlgorithm: 'layered',
                elkDirection: 'RIGHT',
                layoutCenterId: null,
              };
            }
          });
          const savedActive = await storage.read(STORAGE_KEY_ACTIVE) as string | null;
          const activeCanvasId = (savedActive && canvases.find((c) => c.id === savedActive))
            ? savedActive
            : canvases[0].id;

          set({ canvases, activeCanvasId, zoneWireDefinitions: loadedZoneWires, loaded: true, ...syncDerivedState(canvases, activeCanvasId) });
          return;
        }

        // Fresh start
        const canvas = createCanvasInstance();
        set({ canvases: [canvas], activeCanvasId: canvas.id, zoneWireDefinitions: loadedZoneWires, loaded: true, ...syncDerivedState([canvas], canvas.id) });
      } catch (err) {
        // Loading failed after data was already read — log loudly rather than
        // silently discarding the user's canvas.
        rendererLog('canvas', 'error', 'loadCanvas failed — substituting empty canvas', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        });
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
        elkAlgorithm: c.elkAlgorithm,
        elkDirection: c.elkDirection,
        layoutCenterId: c.layoutCenterId,
      }));
      // Ordered double-write for crash recovery. Write the backup FIRST, then
      // the primary. A crash can tear at most one of the two files, so the
      // other is always a complete (old-or-new) copy that loadCanvas can fall
      // back to. We intentionally avoid an atomic temp-file+rename here: the
      // extra filesystem events it generates regress unrelated plugins on
      // Linux CI, whereas an ordered pair of plain writes does not.
      await storage.write(STORAGE_KEY_INSTANCES_BACKUP, data);
      await storage.write(STORAGE_KEY_INSTANCES, data);
      await storage.write(STORAGE_KEY_ACTIVE, activeCanvasId);

      // Persist zone wire definitions — the canvas-owned source of truth for
      // zone-level wires. They survive reload and feed the annex snapshot.
      const zoneData = get().zoneWireDefinitions.map((w) => ({
        id: w.id,
        sourceZoneId: w.sourceZoneId,
        targetId: w.targetId,
        targetType: w.targetType,
      }));
      await storage.write(STORAGE_KEY_ZONE_WIRES, zoneData);
    },

    loadWires: async (storage) => {
      if (_wiresLoading) return;
      _wiresLoading = true;
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
          if (shouldReconcile && (!validIds.has(entry.agentId) || !validIds.has(entry.targetId))) continue;
          // Refresh projectName from the registry on cold start to catch renames.
          if (entry.targetKind === 'group-project') {
            try {
              const project = await window.clubhouse.groupProject.get(entry.targetId) as { name?: string } | null;
              if (project?.name && project.name !== entry.projectName) {
                entry.projectName = project.name;
              }
            } catch {
              // keep cached name as fallback
            }
          }
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
      } finally {
        _wiresLoading = false;
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
        ...(b.routedPath ? { routedPath: b.routedPath } : {}),
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

    addZoneWireDefinition: (wire) => {
      // Deduplicate on (sourceZone, target) so re-dragging the same wire is a no-op.
      const existing = get().zoneWireDefinitions.find(
        (w) => w.sourceZoneId === wire.sourceZoneId && w.targetId === wire.targetId,
      );
      if (existing) return existing;
      const newWire: ZoneWireDefinition = { ...wire, id: generateZoneWireId() };
      set((state) => ({ zoneWireDefinitions: [...state.zoneWireDefinitions, newWire] }));
      return newWire;
    },

    removeZoneWireDefinition: (wireId) => {
      set((state) => ({
        zoneWireDefinitions: state.zoneWireDefinitions.filter((w) => w.id !== wireId),
      }));
    },

    hydrateFromRemote: (canvasData, activeId, remoteWireDefinitions?, remoteZoneWireDefinitions?) => {
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
          elkAlgorithm: existing?.elkAlgorithm ?? s.elkAlgorithm ?? 'layered',
          elkDirection: existing?.elkDirection ?? s.elkDirection ?? 'RIGHT',
          layoutCenterId: existing?.layoutCenterId ?? s.layoutCenterId ?? null,
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

      // Restore zone wire definitions from remote state. Unlike bindings, an
      // empty array is meaningful (all zone wires removed), so only skip when
      // the field is absent entirely.
      const zoneWireUpdate = remoteZoneWireDefinitions && Array.isArray(remoteZoneWireDefinitions)
        ? { zoneWireDefinitions: remoteZoneWireDefinitions as ZoneWireDefinition[] }
        : {};

      set({ canvases, activeCanvasId: resolvedActive, loaded: true, wiresLoaded: true, ...wireUpdate, ...zoneWireUpdate, ...syncDerivedState(canvases, resolvedActive) });
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
      // Determine the ID used in wire definitions — agent views use agentId,
      // other views use the view id directly (mirrors moveView logic).
      const removedView = get().views.find((v) => v.id === viewId);
      const wireId = (removedView?.type === 'agent' && (removedView as AgentCanvasView).agentId)
        ? (removedView as AgentCanvasView).agentId!
        : viewId;

      // LB-CV-H01: atomic update — remove view and clean up orphaned wires in a single set()
      const canvasUpdate = updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(removeViewOp(canvas.views, viewId)),
        selectedViewId: canvas.selectedViewId === viewId ? null : canvas.selectedViewId,
        // LB-M05: clear layoutCenterId if the removed view was the ELK layout center
        layoutCenterId: canvas.layoutCenterId === viewId ? null : canvas.layoutCenterId,
      }));

      // LB-M07: remove orphaned wire definitions referencing the removed view
      const wires = get().wireDefinitions;
      const filtered = wires.filter((w) => w.agentId !== wireId && w.targetId !== wireId);

      // Remove orphaned zone wires referencing the removed view. The view may be
      // referenced by its view id (zone/browser source/target) or by a resolved
      // id (agentId / groupProjectId / queueId) when it is a wire target.
      const removedIds = new Set<string>([viewId, wireId]);
      const gpId = removedView?.metadata?.groupProjectId as string | undefined;
      if (gpId) removedIds.add(gpId);
      const queueId = removedView?.metadata?.queueId as string | undefined;
      if (queueId) removedIds.add(queueId);
      const zoneFiltered = get().zoneWireDefinitions.filter(
        (w) => !removedIds.has(w.sourceZoneId) && !removedIds.has(w.targetId),
      );

      set({
        ...canvasUpdate,
        wireDefinitions: filtered,
        zoneWireDefinitions: zoneFiltered,
      });
    },

    moveView: (viewId, position) => {
      // LB-CV-H02: atomic update — move view and invalidate wire paths in a single set()
      const movedView = get().views.find((v) => v.id === viewId);
      const affectedId = (movedView?.type === 'agent' && (movedView as AgentCanvasView).agentId)
        ? (movedView as AgentCanvasView).agentId!
        : viewId;

      const canvasUpdate = updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(updateViewPosOp(canvas.views, viewId, position)),
      }));

      // Invalidate ELK-routed paths for wires connected to the moved view
      const wires = get().wireDefinitions;
      const needsInvalidation = wires.some((w) => w.routedPath && (w.agentId === affectedId || w.targetId === affectedId));

      set({
        ...canvasUpdate,
        ...(needsInvalidation
          ? {
              wireDefinitions: wires.map((w) =>
                (w.agentId === affectedId || w.targetId === affectedId)
                  ? { ...w, routedPath: undefined }
                  : w,
              ),
            }
          : {}),
      });
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
      const state = get();
      const zone = state.views.find((v) => v.id === zoneId && v.type === 'zone') as ZoneCanvasView | undefined;
      if (!zone) return;

      const canvasUpdate = updateActiveCanvas(state, (canvas) => {
        let views = canvas.views.filter((v) => v.id !== zoneId);
        if (removeContents) {
          const contained = new Set(zone.containedViewIds);
          views = views.filter((v) => !contained.has(v.id));
        }
        return {
          views: recomputeZones(views),
          selectedViewId: canvas.selectedViewId === zoneId ? null : canvas.selectedViewId,
        };
      });

      // LB-CB-002: cascade wire cleanup — remove any wires that reference the zone
      // or (when removeContents=true) any views that were inside it.
      const removedWireIds = new Set<string>([zoneId]);
      if (removeContents) {
        for (const containedId of zone.containedViewIds) {
          const containedView = state.views.find((v) => v.id === containedId);
          const wireId = (containedView?.type === 'agent' && (containedView as AgentCanvasView).agentId)
            ? (containedView as AgentCanvasView).agentId!
            : containedId;
          removedWireIds.add(wireId);
        }
      }
      const filtered = state.wireDefinitions.filter(
        (w) => !removedWireIds.has(w.agentId) && !removedWireIds.has(w.targetId),
      );

      // Remove zone wires originating from or targeting this zone (and, when
      // removeContents, any contained views identified above).
      const removedZoneIds = new Set<string>(removedWireIds);
      removedZoneIds.add(zoneId);
      const zoneFiltered = state.zoneWireDefinitions.filter(
        (w) => !removedZoneIds.has(w.sourceZoneId) && !removedZoneIds.has(w.targetId),
      );

      set({ ...canvasUpdate, wireDefinitions: filtered, zoneWireDefinitions: zoneFiltered });
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

    // ── ELK layout preferences ──────────────────────────────────

    setElkAlgorithm: (value) => {
      set(updateActiveCanvas(get(), () => ({
        elkAlgorithm: value,
      })));
    },

    setElkDirection: (value) => {
      set(updateActiveCanvas(get(), () => ({
        elkDirection: value,
      })));
    },

    setLayoutCenterId: (value) => {
      set(updateActiveCanvas(get(), () => ({
        layoutCenterId: value,
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
