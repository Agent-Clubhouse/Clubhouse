import { create, StoreApi, UseBoundStore } from 'zustand';
import type { ScopedStorage } from '../../../../shared/plugin-types';
import { generateCanvasName } from '../../../../shared/name-generator';
import { rendererLog } from '../../renderer-logger';
import type { CanvasView, CanvasViewType, CanvasInstance, CanvasInstanceData, AgentCanvasView, ZoneCanvasView, Position, Size, Viewport } from './canvas-types';
import type { CanvasWidgetMetadata, CanvasWidgetFilter, CanvasWidgetHandle } from '../../../../shared/plugin-types';
import type { McpBindingEntry } from '../../../stores/mcpBindingStore';
import { generateZoneWireId, type ZoneWireDefinition } from './zone-wire-store';
import { withCanvasPersistenceTimeout } from './canvas-persistence-timeout';
import { persist } from '../../../telemetry/persist';
import { ATTR, tel } from '../../../telemetry';
import { countBucket } from '../../../../shared/telemetry/attributes';
import type { Classification } from '../../../telemetry/facade';
import type { CanvasNavigationSnapshot } from '../../../../shared/canvas-index-types';

type CanvasLoadResult = Parameters<typeof ATTR.canvasLoadResult>[0];

/** Unreadable and failed loads leave the canvas unloaded with saves blocked: errors. */
export function canvasLoadOutcome(result: CanvasLoadResult): Classification {
  if (result === 'unreadable') return { error: 'canvas_unreadable' };
  if (result === 'failed') return { error: 'canvas_load_failed' };
  return 'ok';
}
import {
  createView as createViewOp,
  createPluginView as createPluginViewOp,
  removeView as removeViewOp,
  findAgentCard,
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
import { bindWireDefinition } from './wire-binding';
import { reconcilePersistedWires, REMOVED_CANVAS_VIEW_TYPES } from '../../../../shared/canvas-persistence';
import { removeGroupProjectCanvasReferences } from '../../../../shared/group-project-canvas-cascade';

// ── Store state ──────────────────────────────────────────────────────

/** A timeout cancels only the save that owns this token. */
export interface CanvasSaveToken {
  cancelled: boolean;
}

export interface CanvasState {
  canvases: CanvasInstance[];
  activeCanvasId: string;
  loaded: boolean;
  /** In-memory provenance: Home can project a satellite's data into this store. */
  dataOrigin: 'local' | 'remote' | null;
  /** The exact host snapshot applied after CanvasView's protected save/hydration boundary. */
  remoteSource: { hostId: string; snapshot: unknown } | null;
  /** True once wireDefinitions have been restored from storage.  The auto-save
   *  effect must not fire until this is set, otherwise a debounced save can
   *  overwrite persisted wires with the initial empty array. */
  wiresLoaded: boolean;
  /** Set when loadCanvas could not read the persisted canvas (storage
   *  unreadable even after retries). The canvas stays unloaded and every save
   *  is refused, so an empty placeholder is never written over the real data. */
  loadError: string | null;
  /** Unsaved edits stay in memory across panel remounts until a save succeeds. */
  autosaveFailed: boolean;
  /** A conflict copy was saved separately before newer local data was loaded. */
  unsavedRecoveryCopy: boolean;
  /**
   * Bumped whenever the store's canvases are replaced wholesale (a load, or a
   * satellite's state). Zone expansion treats the next pass as a hydration, so
   * it never adds a group project member (#3357).
   */
  hydrationSeq: number;

  // Lifecycle
  loadCanvas: (storage: ScopedStorage, preferredCopy?: 'backup') => Promise<void>;
  hydrateForNavigation: (snapshot: CanvasNavigationSnapshot, canvasId: string) => void;
  saveCanvas: (storage: ScopedStorage, token?: CanvasSaveToken) => Promise<void>;
  /** Restore this store's failed local edits after viewing a satellite. */
  markSaveTimedOut: (token?: CanvasSaveToken) => void;
  restoreFailedLocalState: (storage: ScopedStorage) => Promise<boolean>;
  hydrateFromRemote: (canvasData: unknown[], activeCanvasId: string, wireDefinitions?: unknown[], zoneWireDefinitions?: unknown[], source?: { hostId: string; snapshot: unknown }) => void;

  // Wire persistence — wireDefinitions is the canvas-owned source of truth for
  // wires, independent of the MCP binding runtime.  Wires survive agent sleep
  // because definitions are not removed when the main process cleans up bindings.
  wireDefinitions: McpBindingEntry[];
  loadWires: (storage: ScopedStorage) => Promise<void>;
  saveWires: (storage: ScopedStorage, token?: CanvasSaveToken) => Promise<void>;
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
  removeDeletedGroupProject: (id: string) => void;

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
// When hydration has to drop malformed records, the raw on-disk value is
// copied to `canvas-instances-recovery-<epoch ms>` before the first save
// replaces the primary and backup with the cleaned data.
const STORAGE_KEY_INSTANCES_RECOVERY_PREFIX = 'canvas-instances-recovery-';
const STORAGE_KEY_ACTIVE = 'canvas-active-id';
const STORAGE_KEY_WIRES = 'canvas-wires';
const STORAGE_KEY_ZONE_WIRES = 'canvas-zone-wires';
const STORAGE_KEY_UNSAVED_COPY_PREFIX = 'canvas-unsaved-copy-';
const DISK_CONTENT_KEYS = [STORAGE_KEY_INSTANCES, STORAGE_KEY_INSTANCES_BACKUP, STORAGE_KEY_WIRES, STORAGE_KEY_ZONE_WIRES];
const diskFingerprint = (value: unknown): string => JSON.stringify(value ?? null);

// ── Helpers ──────────────────────────────────────────────────────────

// Backoff between storage read attempts during hydration. A transiently
// unavailable storage directory (observed lasting ~18ms) must not be mistaken
// for "no data"; a short retry rides it out.
const LOAD_RETRY_DELAYS_MS = [25, 100, 400];

async function readWithRetry(storage: ScopedStorage, key: string): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await storage.read(key);
    } catch (err) {
      if (attempt >= LOAD_RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_DELAYS_MS[attempt]));
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Outcome of reading one persisted copy (primary or backup) of the instances. */
type InstancesCopy =
  | { status: 'missing' }
  | { status: 'unreadable'; error: unknown }
  | { status: 'invalid'; raw: unknown }
  | { status: 'ok' | 'degraded'; raw: unknown; canvases: CanvasInstance[]; issues: string[] };

async function readInstancesCopy(storage: ScopedStorage, key: string): Promise<InstancesCopy> {
  let raw: unknown;
  try {
    raw = await readWithRetry(storage, key);
  } catch (error) {
    return { status: 'unreadable', error };
  }
  if (raw === null || raw === undefined) return { status: 'missing' };
  // A saved canvas is always a non-empty array (>=1 instance).
  if (!Array.isArray(raw) || raw.length === 0) return { status: 'invalid', raw };
  const issues: string[] = [];
  const canvases = raw.map((s) => normalizeCanvasInstance(s, { source: 'disk', issues }));
  return { status: issues.length > 0 ? 'degraded' : 'ok', raw, canvases, issues };
}

const REMOVED_TYPES = REMOVED_CANVAS_VIEW_TYPES;

function createCanvasInstance(): CanvasInstance {
  return {
    id: generateCanvasId(),
    name: generateCanvasName(),
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

function normalizeCanvasInstance(
  raw: unknown,
  /** `issues` collects a note for every record dropped or reset while
   *  normalizing, so disk hydration can tell clean data from degraded data. */
  options: { source: 'disk' | 'remote'; existing?: CanvasInstance; issues?: string[] },
): CanvasInstance {
  const s = raw as Partial<CanvasInstanceData> | null;
  try {
    if (!s || typeof s !== 'object') throw new Error('Canvas instance is not an object');

    if (!Array.isArray(s.views)) options.issues?.push(`canvas ${s.id}: views is not an array`);
    const restoredViews = (Array.isArray(s.views) ? s.views : [])
      .filter((v: any, index: number) => {
        // Drop just the malformed record (e.g. a null view) rather than
        // letting it throw and reset the whole canvas to empty.
        if (!v || typeof v !== 'object') {
          options.issues?.push(`canvas ${s.id}: dropped malformed view at index ${index}`);
          return false;
        }
        return !REMOVED_TYPES.has(v.type);
      })
      .map((v: any) => ({
        ...v,
        metadata: v.metadata ?? {},
        displayName: v.displayName ?? v.title ?? v.type ?? '',
        ...(v.type === 'zone' ? { containedViewIds: v.containedViewIds ?? [] } : {}),
      })) as CanvasView[];
    const rawViewport: Partial<Viewport> = (s.viewport && typeof s.viewport === 'object') ? s.viewport : {};
    const viewport = options.source === 'remote' && options.existing
      ? options.existing.viewport
      : clampViewport({
        panX: rawViewport.panX ?? 0,
        panY: rawViewport.panY ?? 0,
        zoom: rawViewport.zoom ?? 1,
      });

    return {
      id: s.id ?? generateCanvasId(),
      name: s.name ?? generateCanvasName(),
      views: restoredViews,
      viewport,
      nextZIndex: s.nextZIndex ?? restoredViews.length,
      zoomedViewId: s.zoomedViewId ?? null,
      selectedViewId: options.source === 'remote'
        ? (s as Partial<CanvasInstance>).selectedViewId ?? options.existing?.selectedViewId ?? null
        : null,
      minimapAutoHide: options.existing?.minimapAutoHide ?? s.minimapAutoHide ?? true,
      elkAlgorithm: options.existing?.elkAlgorithm ?? s.elkAlgorithm ?? 'layered',
      elkDirection: options.existing?.elkDirection ?? s.elkDirection ?? 'RIGHT',
      layoutCenterId: options.existing?.layoutCenterId ?? s.layoutCenterId ?? null,
    };
  } catch (err) {
    options.issues?.push(`canvas ${s?.id}: ${errorMessage(err)}`);
    rendererLog('canvas', 'error', `Skipped malformed canvas instance on ${options.source}`, {
      meta: { id: s?.id, error: err instanceof Error ? err.message : String(err) },
    });
    return {
      id: s?.id ?? generateCanvasId(),
      name: s?.name ?? generateCanvasName(),
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
}

// ── Store factory ────────────────────────────────────────────────────

export function createCanvasStore(): UseBoundStore<StoreApi<CanvasState>> {
  const initialCanvas = createCanvasInstance();
  // This store owns one local storage scope across panel remounts. An issued
  // IPC write cannot be revoked. Keep one in flight and only the newest pending
  // request per key, so wedged storage cannot retain an unbounded save history.
  interface PendingWrite {
    storage: ScopedStorage;
    value: unknown;
    assertCurrent: () => void;
    resolve: () => void;
    reject: (error: unknown) => void;
  }
  interface WriteQueue { pending?: PendingWrite }
  const writeQueues = new Map<string, WriteQueue>();
  const runWrite = async (key: string, queue: WriteQueue, request: PendingWrite): Promise<void> => {
    try {
      request.assertCurrent();
      await request.storage.write(key, request.value);
      request.resolve();
    } catch (error) {
      request.reject(error);
    } finally {
      const next = queue.pending;
      queue.pending = undefined;
      if (next) void runWrite(key, queue, next);
      else writeQueues.delete(key);
    }
  };
  const writeInOrder = (storage: ScopedStorage, key: string, value: unknown, assertCurrent: () => void = () => {}): Promise<void> => new Promise((resolve, reject) => {
    const request = { storage, value, assertCurrent, resolve, reject };
    const queue = writeQueues.get(key);
    if (queue) {
      queue.pending?.reject(new Error('Canvas save superseded by newer local changes'));
      queue.pending = request;
    } else {
      const created: WriteQueue = {};
      writeQueues.set(key, created);
      void runWrite(key, created, request);
    }
  });
  let _loadGeneration = 0;
  let _wiresLoading: number | undefined;
  let _wiresOrigin: 'local' | 'remote' | null = null;
  let _zoneWiresOrigin: 'local' | 'remote' | null = null;

  // Persistence gates, set by loadCanvas/loadWires. Autosave fires shortly
  // after hydration regardless of user edits, and each save rewrites the
  // primary AND the backup — so if hydration produced the wrong state, every
  // recovery copy is lost. Saves are only allowed once hydration has shown
  // the in-memory state is safe to persist:
  //  - 'blocked':        not hydrated from local storage, or hydration failed.
  //  - 'verify-empty':   nothing was found; re-check storage before the first
  //                      write in case the "missing" data was only transiently
  //                      unavailable.
  //  - 'snapshot-first': malformed records were dropped; copy the raw data to
  //                      a recovery key before the first write replaces it.
  //  - 'ok':             clean hydration.
  type CanvasPersist = 'blocked' | 'verify-empty' | 'snapshot-first' | 'ok';
  let _canvasPersist: CanvasPersist = 'blocked';
  let _recoverySnapshot: unknown;
  // Last observed local disk contents, updated after each successful write.
  let _diskBaseline = new Map<string, string>();
  let _restoredBaseline: Map<string, string> | undefined;
  let _checkingRestore: { generation: number; promise: Promise<boolean> } | undefined;
  const verifyRestoredDisk = async (storage: ScopedStorage): Promise<boolean> => {
    if (!_restoredBaseline) return false;
    if (_checkingRestore?.generation === _loadGeneration) return _checkingRestore.promise;
    const baseline = _restoredBaseline;
    const generation = _loadGeneration;
    store.setState({ loaded: false });
    const checking = (async () => {
      const values = await withCanvasPersistenceTimeout(Promise.all(DISK_CONTENT_KEYS.map((key) => storage.read(key))));
      if (generation !== _loadGeneration) throw new Error('Canvas source changed while checking unsaved changes');
      const changed = DISK_CONTENT_KEYS.some((key, index) => baseline.get(key) !== diskFingerprint(values[index]));
      if (changed) {
        const state = store.getState();
        const localWires = _wiresOrigin === 'local' ? state.wireDefinitions : [];
        const localZoneWires = _zoneWiresOrigin === 'local' ? state.zoneWireDefinitions : [];
        // Use an independent versioned bundle, never an active or automatic
        // recovery key. A fresh UUID avoids replacing any previous copy.
        const key = `${STORAGE_KEY_UNSAVED_COPY_PREFIX}${Date.now()}-${crypto.randomUUID()}`;
        if ((await withCanvasPersistenceTimeout(storage.list())).includes(key)) throw new Error('Canvas recovery copy already exists');
        await withCanvasPersistenceTimeout(writeInOrder(storage, key, {
          version: 1, canvases: state.canvases, activeCanvasId: state.activeCanvasId,
          wireDefinitions: localWires, zoneWireDefinitions: localZoneWires,
          // A divergent backup may be the newer half of an interrupted save.
          // Keep BOTH disk versions before any normal autosave can rotate them.
          ...(diskFingerprint(values[0]) !== diskFingerprint(values[1])
            ? { diskCopies: { primary: values[0] ?? null, backup: values[1] ?? null } } : {}),
        }));
        if (generation !== _loadGeneration) throw new Error('Canvas source changed while keeping unsaved changes');
        rendererLog('canvas', 'info', 'Kept unsaved canvas recovery copy', { meta: { key } });
        _restoredBaseline = undefined;
        // Keep all retained wires closed while the newer disk version loads.
        _wiresPersistBlocked = 'remote';
        _zoneWiresPersistBlocked = 'remote';
        const backupChanged = baseline.get(STORAGE_KEY_INSTANCES_BACKUP) !== diskFingerprint(values[1]);
        const loading = state.loadCanvas(storage, backupChanged ? 'backup' : undefined);
        const localGeneration = _loadGeneration;
        await loading;
        if (localGeneration !== _loadGeneration) return true;
        await state.loadWires(storage);
        if (localGeneration !== _loadGeneration) return true;
        store.setState({ unsavedRecoveryCopy: true, autosaveFailed: !store.getState().loaded });
        // This save was requested for the retained version, not the newer
        // disk data. Leave the latter alone until its own next edit/save.
        return true;
      }
      _restoredBaseline = undefined;
      return false;
    })().finally(() => {
      if (generation === _loadGeneration) store.setState({ loaded: true });
      if (_checkingRestore?.promise === checking) _checkingRestore = undefined;
    });
    _checkingRestore = { generation, promise: checking };
    return checking;
  };
  type WirePersistBlock = 'remote' | 'local-unreadable' | null;
  let _zoneWiresPersistBlocked: WirePersistBlock = null;
  let _wiresPersistBlocked: WirePersistBlock = null;
  // Compare wire content so no-op edits do not turn hydration's empty list
  // into a failed save. Never persist over data we could not read.
  let _unreadableWiresBaseline: string | undefined;
  let _unreadableZoneWiresBaseline: string | undefined;
  // Each project has its own store; Home has a singleton store. Keep the
  // failed local state AND its persistence guards here while viewing remote.
  let _failedLocalState: {
    state: CanvasState;
    canvasPersist: CanvasPersist;
    recoverySnapshot: unknown;
    wiresPersistBlocked: WirePersistBlock;
    zoneWiresPersistBlocked: WirePersistBlock;
    unreadableWiresBaseline: typeof _unreadableWiresBaseline;
    unreadableZoneWiresBaseline: typeof _unreadableZoneWiresBaseline;
    diskBaseline: Map<string, string>;
    wiresOrigin: typeof _wiresOrigin;
    zoneWiresOrigin: typeof _zoneWiresOrigin;
  } | undefined;

  const store = create<CanvasState>((set, get) => ({
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
    dataOrigin: null,
    remoteSource: null,
    wiresLoaded: false,
    loadError: null,
    autosaveFailed: false,
    unsavedRecoveryCopy: false,
    hydrationSeq: 0,

    activeCanvas: () => {
      const state = get();
      return state.canvases.find((c) => c.id === state.activeCanvasId) ?? state.canvases[0];
    },

    // ── Lifecycle ──────────────────────────────────────────────────

    hydrateForNavigation: (snapshot, canvasId) => {
      if (!snapshot.canvases.length || snapshot.canvases.some((raw) => {
        if (!raw || typeof raw !== 'object') return true;
        const canvas = raw as Partial<CanvasInstanceData>;
        return typeof canvas.id !== 'string' || !canvas.id || typeof canvas.name !== 'string' || !Array.isArray(canvas.views);
      })) throw new Error('The saved Canvas is incomplete. Repair it and retry Open.');
      const issues: string[] = [];
      const canvases = snapshot.canvases.map((raw) => normalizeCanvasInstance(raw, { source: 'disk', issues }));
      if (issues.length || !canvases.some((canvas) => canvas.id === canvasId)) {
        throw new Error('This Canvas is no longer available. Retry Open to refresh its representations.');
      }
      const wireDefinitions: McpBindingEntry[] = snapshot.wires.map((wire) => {
        const kind = wire.targetKind;
        if (kind !== 'agent' && kind !== 'browser' && kind !== 'terminal' && kind !== 'group-project') {
          throw new Error('Canvas connections contain an unsupported target kind. Repair the saved Canvas and retry Open.');
        }
        return { ...wire, targetKind: kind };
      });
      const zoneWireDefinitions: ZoneWireDefinition[] = snapshot.zoneWires.map((raw) => {
        if (!raw || typeof raw !== 'object') throw new Error('Canvas zone connections are incomplete. Repair them and retry Open.');
        const wire = raw as Partial<ZoneWireDefinition>;
        if (typeof wire.id !== 'string' || typeof wire.sourceZoneId !== 'string'
          || typeof wire.targetId !== 'string' || (wire.targetType !== 'agent' && wire.targetType !== 'zone'
            && wire.targetType !== 'group-project' && wire.targetType !== 'browser')) {
          throw new Error('Canvas zone connections are incomplete. Repair them and retry Open.');
        }
        return { id: wire.id, sourceZoneId: wire.sourceZoneId, targetId: wire.targetId, targetType: wire.targetType };
      });
      ++_loadGeneration;
      _failedLocalState = undefined;
      _restoredBaseline = undefined;
      _wiresOrigin = 'local';
      _zoneWiresOrigin = 'local';
      _canvasPersist = 'ok';
      _wiresPersistBlocked = null;
      _zoneWiresPersistBlocked = null;
      set({
        canvases, activeCanvasId: canvasId, wireDefinitions, zoneWireDefinitions, loaded: true, dataOrigin: 'local', wiresLoaded: true, loadError: null,
        ...syncDerivedState(canvases, canvasId),
      });
    },

    // Measured as `clubhouse.canvas.load` (spec §4.10); `loadResult` records
    // which branch hydration took. Recovery details are persist telemetry.
    loadCanvas: (storage, preferredCopy) => tel.flow<Promise<CanvasLoadResult>>('clubhouse.canvas.load', {}, async (span) => {
      const generation = ++_loadGeneration;
      let loadResult: CanvasLoadResult = 'failed';
      const nextBaseline = new Map<string, string>();
      _canvasPersist = 'blocked';
      _recoverySnapshot = undefined;
      try {
        // Restore zone wire definitions alongside the canvas. They expand into
        // bindings at runtime (no MCP state of their own), so they belong with
        // the canvas data rather than the MCP wire restore.
        let loadedZoneWires: ZoneWireDefinition[] = [];
        // The guards re-open only with the set() that swaps in this data: until
        // then the store may still hold a satellite's canvas (hydrateFromRemote),
        // and an autosave during a slow load must not write it here.
        let nextZoneWiresBlocked = false;
        let nextPersist: 'blocked' | 'verify-empty' | 'snapshot-first' | 'ok' = 'blocked';
        try {
          const savedZoneWires = await readWithRetry(storage, STORAGE_KEY_ZONE_WIRES) as ZoneWireDefinition[] | null;
          nextBaseline.set(STORAGE_KEY_ZONE_WIRES, diskFingerprint(savedZoneWires));
          if (savedZoneWires && Array.isArray(savedZoneWires)) {
            loadedZoneWires = savedZoneWires.filter(
              (w) => w && w.id && w.sourceZoneId && w.targetId && w.targetType,
            );
          }
        } catch (err) {
          // Unreadable — don't let saveCanvas persist the empty list over it.
          nextZoneWiresBlocked = true;
          rendererLog('canvas', 'error', 'Zone wires unreadable — zone wire saves disabled for this session', {
            meta: { error: errorMessage(err) },
          });
        }

        // Prefer a clean copy. The backup is written before the primary, so it
        // is always a complete old-or-new copy and is safe to fall back to when
        // the primary is torn, missing, unreadable or has malformed records.
        const primary = await readInstancesCopy(storage, STORAGE_KEY_INSTANCES);
        const backup = await readInstancesCopy(storage, STORAGE_KEY_INSTANCES_BACKUP);
        if (generation !== _loadGeneration) return 'ok';
        for (const [key, copy] of [[STORAGE_KEY_INSTANCES, primary], [STORAGE_KEY_INSTANCES_BACKUP, backup]] as const) {
          if (copy.status !== 'unreadable') nextBaseline.set(key, diskFingerprint(copy.status === 'missing' ? undefined : copy.raw));
        }
        let chosen: InstancesCopy = preferredCopy === 'backup' && backup.status === 'ok' ? backup : primary;
        if (primary.status !== 'ok') {
          if (backup.status === 'ok') {
            loadResult = 'recovered_from_backup';
            persist.recovery('canvas', 'restored_from_backup');
            rendererLog('canvas', 'warn', 'Primary canvas data missing/corrupt — recovered from backup', {
              meta: { primary: primary.status, backupCanvases: backup.canvases.length },
            });
            chosen = backup;
          } else if (primary.status === 'unreadable' || backup.status === 'unreadable') {
            // Data may exist but can't be read. Hydrating anything here would
            // let autosave overwrite it, so stay unloaded with saves blocked.
            const error = primary.status === 'unreadable'
              ? primary.error
              : (backup as Extract<InstancesCopy, { status: 'unreadable' }>).error;
            persist.recovery('canvas', 'unreadable');
            rendererLog('canvas', 'error', 'Canvas data unreadable — not loading, saves blocked', {
              meta: { primary: primary.status, backup: backup.status, error: errorMessage(error) },
            });
            set({ loaded: false, dataOrigin: null, loadError: `Canvas data could not be read: ${errorMessage(error)}` });
            loadResult = 'unreadable';
            span.set(ATTR.canvasLoadResult(loadResult));
            return loadResult;
          } else if (primary.status !== 'degraded' && (backup.status === 'degraded' || primary.status === 'missing')) {
            // Salvage whichever copy still has valid records.
            chosen = backup;
          }
        }

        let canvases: CanvasInstance[];
        if (chosen.status === 'ok') {
          canvases = chosen.canvases;
          nextPersist = 'ok';
          if (loadResult !== 'recovered_from_backup') loadResult = 'ok';
        } else if (chosen.status === 'missing') {
          canvases = [createCanvasInstance()];
          nextPersist = 'verify-empty';
          loadResult = 'new';
        } else if (chosen.status === 'unreadable') {
          throw chosen.error; // unreachable — handled above
        } else {
          // Degraded or invalid: keep every record that survived, and preserve
          // the raw data before the first save rewrites primary and backup.
          canvases = chosen.status === 'degraded' ? chosen.canvases : [createCanvasInstance()];
          _recoverySnapshot = chosen.raw;
          nextPersist = 'snapshot-first';
          loadResult = 'degraded';
          persist.recovery('canvas', 'records_dropped');
          rendererLog('canvas', 'warn', 'Canvas data had malformed records — loaded what was valid', {
            meta: { issues: chosen.status === 'degraded' ? chosen.issues : ['instances is not a non-empty array'] },
          });
        }

        // The active-canvas id is cosmetic; failing to read it must not fail
        // (or empty) the whole load.
        let savedActive: string | null = null;
        try {
          savedActive = await readWithRetry(storage, STORAGE_KEY_ACTIVE) as string | null;
        } catch (err) {
          rendererLog('canvas', 'warn', 'Active canvas id unreadable — defaulting to first canvas', {
            meta: { error: errorMessage(err) },
          });
        }
        const activeCanvasId = (savedActive && canvases.find((c) => c.id === savedActive))
          ? savedActive
          : canvases[0].id;

        if (generation !== _loadGeneration) return 'ok';
        if (_diskBaseline.has(STORAGE_KEY_WIRES)) nextBaseline.set(STORAGE_KEY_WIRES, _diskBaseline.get(STORAGE_KEY_WIRES)!);
        _diskBaseline = nextBaseline;
        _restoredBaseline = undefined;
        _canvasPersist = nextPersist;
        _zoneWiresOrigin = 'local';
        const resetRemoteWires = _wiresOrigin !== 'local';
        if (resetRemoteWires) _wiresOrigin = null;
        _zoneWiresPersistBlocked = nextZoneWiresBlocked ? 'local-unreadable' : null;
        _unreadableZoneWiresBaseline = JSON.stringify(loadedZoneWires);
        set((state) => ({ canvases, activeCanvasId, ...(resetRemoteWires ? { wireDefinitions: [], wiresLoaded: false } : {}), zoneWireDefinitions: loadedZoneWires, loaded: true, dataOrigin: 'local', loadError: null, hydrationSeq: state.hydrationSeq + 1, ...syncDerivedState(canvases, activeCanvasId) }));
        span.set(
          ATTR.canvasCount(canvases.length),
          ATTR.canvasViewCount(countBucket(canvases.reduce((n, c) => n + c.views.length, 0))),
        );
      } catch (err) {
        if (generation !== _loadGeneration) return 'ok';
        // Unexpected failure — never substitute an empty canvas, which the
        // next autosave would persist over the user's data.
        _canvasPersist = 'blocked';
        loadResult = 'failed';
        rendererLog('canvas', 'error', 'loadCanvas failed — not loading, saves blocked', {
          meta: { error: errorMessage(err) },
        });
        set({ loaded: false, dataOrigin: null, loadError: `Canvas failed to load: ${errorMessage(err)}` });
      }
      span.set(ATTR.canvasLoadResult(loadResult));
      return loadResult;
    }, { classify: canvasLoadOutcome }).then((): void => undefined),

    saveCanvas: async (storage, token) => {
      const generation = _loadGeneration;
      const assertCurrent = () => {
        if (token?.cancelled || generation !== _loadGeneration) throw new Error('Canvas source changed before the local save completed');
      };
      const diskBaseline = _diskBaseline;
      if (_restoredBaseline && await verifyRestoredDisk(storage)) return;
      if (_canvasPersist === 'blocked') {
        persist.guardBlocked('canvas', 'not_hydrated');
        rendererLog('canvas', 'warn', 'saveCanvas skipped — canvas was not hydrated from storage');
        return;
      }
      if (_canvasPersist === 'verify-empty') {
        // Hydration found nothing. Confirm that's still true before the first
        // write — a transiently unavailable directory reads back as missing.
        let primary: unknown;
        let backup: unknown;
        try {
          primary = await storage.read(STORAGE_KEY_INSTANCES);
          assertCurrent();
          backup = await storage.read(STORAGE_KEY_INSTANCES_BACKUP);
          assertCurrent();
        } catch (err) {
          rendererLog('canvas', 'warn', 'saveCanvas failed — could not confirm storage is empty', {
            meta: { error: errorMessage(err) },
          });
          // Keep the guard closed and let autosave retain the edits and offer Retry.
          throw err;
        }
        const hasData = (v: unknown) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
        if (hasData(primary) || hasData(backup)) {
          persist.guardBlocked('canvas', 'verify_empty');
          rendererLog('canvas', 'error', 'Canvas data appeared after an empty load — reloading instead of overwriting it');
          await get().loadCanvas(storage);
          return;
        }
        // The guard may have closed while we read (hydrateFromRemote); keep it closed.
        if (_canvasPersist !== 'verify-empty') return;
        _canvasPersist = 'ok';
      }
      if (_canvasPersist === 'snapshot-first') {
        // If this write fails we stay in 'snapshot-first' and retry next save.
        await writeInOrder(storage, `${STORAGE_KEY_INSTANCES_RECOVERY_PREFIX}${Date.now()}`, _recoverySnapshot, assertCurrent);
        assertCurrent();
        if (_canvasPersist !== 'snapshot-first') return;
        _recoverySnapshot = undefined;
        _canvasPersist = 'ok';
      }
      if (_canvasPersist !== 'ok') return;
      if (_zoneWiresPersistBlocked === 'local-unreadable' && JSON.stringify(get().zoneWireDefinitions) !== _unreadableZoneWiresBaseline) {
        throw new Error('Canvas zone connection changes not saved: persisted zone connections could not be read');
      }

      assertCurrent();
      // Capture everything before the first await: the store can switch to a
      // satellite's canvas while these writes are in flight.
      const { canvases, activeCanvasId, zoneWireDefinitions } = get();
      const zoneWiresBlocked = _zoneWiresPersistBlocked;
      const zoneData = zoneWireDefinitions.map((w) => ({
        id: w.id,
        sourceZoneId: w.sourceZoneId,
        targetId: w.targetId,
        targetType: w.targetType,
      }));
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
      await writeInOrder(storage, STORAGE_KEY_INSTANCES_BACKUP, data, assertCurrent);
      diskBaseline.set(STORAGE_KEY_INSTANCES_BACKUP, diskFingerprint(data));
      assertCurrent();
      await writeInOrder(storage, STORAGE_KEY_INSTANCES, data, assertCurrent);
      diskBaseline.set(STORAGE_KEY_INSTANCES, diskFingerprint(data));
      assertCurrent();
      await writeInOrder(storage, STORAGE_KEY_ACTIVE, activeCanvasId, assertCurrent);
      assertCurrent();

      // Persist zone wire definitions — the canvas-owned source of truth for
      // zone-level wires. They survive reload and feed the annex snapshot.
      if (!zoneWiresBlocked) {
        await writeInOrder(storage, STORAGE_KEY_ZONE_WIRES, zoneData, assertCurrent);
        diskBaseline.set(STORAGE_KEY_ZONE_WIRES, diskFingerprint(zoneData));
      }
      assertCurrent();
      if (get().dataOrigin === 'local') _failedLocalState = undefined;
    },

    loadWires: async (storage) => {
      const generation = _loadGeneration;
      if (_wiresLoading === generation) return;
      _wiresLoading = generation;
      if (_wiresPersistBlocked !== 'local-unreadable') _unreadableWiresBaseline = JSON.stringify(_wiresOrigin === 'remote' ? [] : get().wireDefinitions);
      try {
        let saved: McpBindingEntry[] | null;
        try {
          saved = await readWithRetry(storage, STORAGE_KEY_WIRES) as McpBindingEntry[] | null;
        } catch (err) {
          // Unreadable — mark loaded so canvas autosave isn't held up, but
          // block saveWires so the empty list never overwrites the real wires.
          if (generation !== _loadGeneration) return;
          _wiresPersistBlocked = 'local-unreadable';
          rendererLog('canvas', 'error', 'Canvas wires unreadable — wire saves disabled for this session', {
            meta: { error: errorMessage(err) },
          });
          const clearRemote = _wiresOrigin === 'remote';
          _wiresOrigin = 'local';
          set({ ...(clearRemote ? { wireDefinitions: [] } : {}), wiresLoaded: true });
          return;
        }
        if (generation !== _loadGeneration) return;
        _diskBaseline.set(STORAGE_KEY_WIRES, diskFingerprint(saved));
        // Re-open the guard only with the set() that swaps in local wires: the
        // store may still hold a satellite's (hydrateFromRemote), and they must
        // never be saved here. No local wires means none, not the satellite's.
        if (!saved || !Array.isArray(saved) || saved.length === 0) {
          _wiresPersistBlocked = null;
          _wiresOrigin = 'local';
          set({ wireDefinitions: [], wiresLoaded: true });
          return;
        }

        // Restore each binding, skipping stale ones whose source/target no
        // longer exist. Bindings reference agentIds (durable_*/quick_*),
        // groupProjectIds, or browser widget view IDs. The same rules run in
        // the main process when it rebuilds bindings at startup (#1544).
        // Wire definitions are stored in the canvas store so they survive agent
        // sleep/wake cycles independently of the MCP binding runtime.
        const allViews = get().canvases.flatMap((c) => c.views);
        const restoredDefinitions: McpBindingEntry[] = [];
        for (const entry of reconcilePersistedWires(saved, allViews)) {
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
            await bindWireDefinition(entry);
          } catch {
            // Binding restore failed (e.g. MCP not enabled or agent sleeping) —
            // keep the wire definition so the wire remains visible and persisted
          }
        }
        if (generation !== _loadGeneration) return;
        _wiresPersistBlocked = null;
        _wiresOrigin = 'local';
        set({ wireDefinitions: restoredDefinitions, wiresLoaded: true });
      } catch (err) {
        // Restore failed part-way — keep whatever was persisted rather than
        // overwriting it with a partial list, but don't hold up canvas autosave.
        if (generation !== _loadGeneration) return;
        _wiresPersistBlocked = 'local-unreadable';
        rendererLog('canvas', 'error', 'Canvas wire restore failed — wire saves disabled for this session', {
          meta: { error: errorMessage(err) },
        });
        const clearRemote = _wiresOrigin === 'remote';
        _wiresOrigin = 'local';
        set({ ...(clearRemote ? { wireDefinitions: [] } : {}), wiresLoaded: true });
      } finally {
        if (_wiresLoading === generation) _wiresLoading = undefined;
      }
    },

    saveWires: async (storage, token) => {
      const generation = _loadGeneration;
      const diskBaseline = _diskBaseline;
      if (_restoredBaseline && await verifyRestoredDisk(storage)) return;
      if (_wiresPersistBlocked === 'remote') return;
      if (_wiresPersistBlocked === 'local-unreadable') {
        if (JSON.stringify(get().wireDefinitions) !== _unreadableWiresBaseline) {
          throw new Error('Canvas connection changes not saved: persisted connections could not be read');
        }
        rendererLog('canvas', 'warn', 'saveWires skipped — persisted wires could not be read');
        return;
      }
      const assertCurrent = () => {
        if (token?.cancelled || generation !== _loadGeneration) throw new Error('Canvas source changed before the local connection save');
      };
      assertCurrent();
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
      await writeInOrder(storage, STORAGE_KEY_WIRES, data, assertCurrent);
      diskBaseline.set(STORAGE_KEY_WIRES, diskFingerprint(data));
      if (token?.cancelled || generation !== _loadGeneration) throw new Error('Canvas source changed before the local connection save completed');
      if (get().dataOrigin === 'local') _failedLocalState = undefined;
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

    markSaveTimedOut: (token) => {
      // Stop this writer even when no satellite snapshot has arrived. A newer
      // save may already be running, so a timeout must not invalidate it.
      if (token) token.cancelled = true;
      else ++_loadGeneration;
      if (get().dataOrigin === 'local') _restoredBaseline = _diskBaseline;
      set({ autosaveFailed: true });
    },

    restoreFailedLocalState: async (storage) => {
      if (!_failedLocalState) return false;
      const local = _failedLocalState;
      _failedLocalState = undefined;
      ++_loadGeneration;
      _canvasPersist = local.canvasPersist;
      _recoverySnapshot = local.recoverySnapshot;
      _wiresPersistBlocked = local.wiresPersistBlocked;
      _zoneWiresPersistBlocked = local.zoneWiresPersistBlocked;
      _unreadableWiresBaseline = local.unreadableWiresBaseline;
      _unreadableZoneWiresBaseline = local.unreadableZoneWiresBaseline;
      _wiresOrigin = local.wiresOrigin;
      _zoneWiresOrigin = local.zoneWiresOrigin;
      _diskBaseline = local.diskBaseline;
      _restoredBaseline = local.diskBaseline;
      set({ ...local.state, autosaveFailed: true, hydrationSeq: get().hydrationSeq + 1 });
      try {
        const recovered = await verifyRestoredDisk(storage);
        if (!recovered && !get().wiresLoaded && get().dataOrigin === 'local') {
          const pending = get().wireDefinitions;
          const generation = _loadGeneration;
          // These wires were edited before the previous local read finished;
          // a failed re-read must not classify them as already persisted.
          _wiresPersistBlocked = 'local-unreadable';
          _unreadableWiresBaseline = '[]';
          await withCanvasPersistenceTimeout(get().loadWires(storage));
          if (generation === _loadGeneration && pending.length) {
            for (const wire of pending) {
              get().addWireDefinition(wire);
              get().updateWireDefinition(wire.agentId, wire.targetId, wire);
            }
          }
        }
      } catch (error) {
        rendererLog('canvas', 'warn', 'Could not resume retained canvas save', { meta: { error: errorMessage(error) } });
      }
      return true;
    },

    hydrateFromRemote: (canvasData, activeId, remoteWireDefinitions?, remoteZoneWireDefinitions?, source?) => {
      if (!canvasData || !Array.isArray(canvasData) || canvasData.length === 0) return;
      const local = get();
      if (local.dataOrigin === 'local' && local.autosaveFailed) {
        _failedLocalState = {
          state: { ...local,
            wireDefinitions: _wiresOrigin === 'local' ? local.wireDefinitions : [],
            zoneWireDefinitions: _zoneWiresOrigin === 'local' ? local.zoneWireDefinitions : [],
          }, canvasPersist: _canvasPersist, recoverySnapshot: _recoverySnapshot,
          wiresPersistBlocked: _wiresPersistBlocked, zoneWiresPersistBlocked: _zoneWiresPersistBlocked,
          unreadableWiresBaseline: _unreadableWiresBaseline, unreadableZoneWiresBaseline: _unreadableZoneWiresBaseline,
          diskBaseline: _diskBaseline, wiresOrigin: _wiresOrigin, zoneWiresOrigin: _zoneWiresOrigin,
        };
      }
      ++_loadGeneration;
      _restoredBaseline = undefined;
      // From here the store holds a satellite's canvas, which must never be
      // written to this machine's storage (the app canvas store is shared by
      // the local and remote views). The next loadCanvas/loadWires from local
      // storage re-opens the guards.
      _canvasPersist = 'blocked';
      _wiresPersistBlocked = 'remote';
      _zoneWiresPersistBlocked = 'remote';
      _wiresOrigin = 'remote';
      _zoneWiresOrigin = 'remote';
      const existingState = get();
      const existingCanvasMap = new Map(existingState.canvases.map((c) => [c.id, c]));

      const canvases: CanvasInstance[] = (canvasData as CanvasInstanceData[]).map((s) =>
        normalizeCanvasInstance(s, { source: 'remote', existing: existingCanvasMap.get(s?.id) }),
      );

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

      set((state) => ({ canvases, activeCanvasId: resolvedActive, loaded: true, dataOrigin: 'remote', remoteSource: source ?? null, wiresLoaded: true, hydrationSeq: state.hydrationSeq + 1, ...wireUpdate, ...zoneWireUpdate, ...syncDerivedState(canvases, resolvedActive) }));
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
        // Inserting into an unhydrated placeholder and saving it would
        // overwrite the canvases we failed to read.
        if (!get().loaded) throw new Error(get().loadError ?? 'Canvas data could not be loaded');
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

    removeDeletedGroupProject: (id) => {
      const state = get();
      if (state.dataOrigin !== 'local') return;
      const result = removeGroupProjectCanvasReferences(state.canvases, state.wireDefinitions, state.zoneWireDefinitions, id);
      const canvases = result.instances as CanvasInstance[];
      set({ canvases, wireDefinitions: result.wires as McpBindingEntry[], zoneWireDefinitions: result.zoneWires as ZoneWireDefinition[],
        ...syncDerivedState(canvases, state.activeCanvasId) });
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
      // A duplicate agent card (saved before #2415): the agent's other card
      // stays, and so do the wires it shares with this one.
      const agentStays = wireId !== viewId && !!findAgentCard(get().views, wireId, viewId);

      // LB-CV-H01: atomic update — remove view and clean up orphaned wires in a single set()
      const canvasUpdate = updateActiveCanvas(get(), (canvas) => ({
        views: recomputeZones(removeViewOp(canvas.views, viewId)),
        selectedViewId: canvas.selectedViewId === viewId ? null : canvas.selectedViewId,
        // LB-M05: clear layoutCenterId if the removed view was the ELK layout center
        layoutCenterId: canvas.layoutCenterId === viewId ? null : canvas.layoutCenterId,
      }));

      // LB-M07: remove orphaned wire definitions referencing the removed view
      const wires = get().wireDefinitions;
      const filtered = agentStays ? wires : wires.filter((w) => w.agentId !== wireId && w.targetId !== wireId);

      // Remove orphaned zone wires referencing the removed view. The view may be
      // referenced by its view id (zone/browser source/target) or by a resolved
      // id (agentId / groupProjectId) when it is a wire target.
      const removedIds = new Set<string>(agentStays ? [viewId] : [viewId, wireId]);
      const gpId = removedView?.metadata?.groupProjectId as string | undefined;
      if (gpId) removedIds.add(gpId);
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
  // Wire definitions can also change while removing views, or applying navigation. Track every local mutation centrally.
  store.subscribe((state, previous) => {
    if (state.dataOrigin !== 'local' || previous.dataOrigin !== 'local') return;
    if (state.wireDefinitions !== previous.wireDefinitions) _wiresOrigin = 'local';
    if (state.zoneWireDefinitions !== previous.zoneWireDefinitions) _zoneWiresOrigin = 'local';
  });
  return store;
}
