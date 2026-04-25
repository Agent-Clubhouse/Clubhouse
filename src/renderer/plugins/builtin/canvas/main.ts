import React, { useEffect, useCallback, useRef, useState } from 'react';
import type { PluginContext, PluginAPI, PluginModule, CanvasWidgetFilter } from '../../../../shared/plugin-types';
import type { CanvasMutation } from '../../../../shared/types';
import type { CanvasView, CanvasViewType, AgentCanvasView } from './canvas-types';
import { createCanvasStore } from './canvas-store';
import { computeAdjacentPosition } from './canvas-operations';
import { CanvasTabBar } from './CanvasTabBar';
import { CanvasWorkspace } from './CanvasWorkspace';
import { setCanvasQueryProvider } from '../../plugin-api-canvas';
import { broadcastCanvasState, sendRemoteCanvasMutation } from './canvas-sync';
import { PoppedOutPlaceholder } from '../../../features/popout/PoppedOutPlaceholder';
import { usePopouts } from '../../../hooks/usePopouts';
import { isRemoteProjectId, useRemoteProjectStore } from '../../../stores/remoteProjectStore';
import { useUIStore } from '../../../stores/uiStore';
import { useMcpBindingStore, type McpBindingEntry } from '../../../stores/mcpBindingStore';
import { usePluginStore } from '../../plugin-store';
import { useAgentStore } from '../../../stores/agentStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { ExportBlueprintDialog } from '../../../features/blueprints/ExportBlueprintDialog';

/**
 * Collect the real IDs a canvas view participates in for MCP bindings.
 * Returns { agentId, targetIds } where targetIds are IDs used as binding.targetId.
 */
function viewBindingIds(view: CanvasView): { agentId: string | null; targetIds: string[] } {
  if (view.type === 'agent') {
    const av = view as AgentCanvasView;
    return { agentId: av.agentId ?? null, targetIds: av.agentId ? [av.agentId] : [] };
  }
  if (view.type === 'plugin') {
    const gpId = view.metadata?.groupProjectId as string | undefined;
    if (gpId) return { agentId: null, targetIds: [gpId] };
    // Browser widgets use view.id as targetId
    return { agentId: null, targetIds: [view.id] };
  }
  return { agentId: null, targetIds: [] };
}

/** Find all bindings that reference a given view (as source or target). */
export function findBindingsForView(view: CanvasView, bindings: McpBindingEntry[]): McpBindingEntry[] {
  const { agentId, targetIds } = viewBindingIds(view);
  return bindings.filter((b) =>
    (agentId && b.agentId === agentId) ||
    targetIds.includes(b.targetId),
  );
}

// App-mode canvas store: single instance shared across all projects
export const useAppCanvasStore = createCanvasStore();

// Project-mode canvas stores: one per project, keyed by projectId
const projectCanvasStores = new Map<string, ReturnType<typeof createCanvasStore>>();

// Stable singleton fallback for callers that resolve a project store with a
// null/undefined projectId (e.g. transient states during project switching,
// command palette lookups when no project is active, or pop-out windows that
// haven't received their context yet). Mission 71: prior to this fix the
// fallback was `return createCanvasStore()` per call, which made every
// re-render observe a fresh store with the initial canvas — addCanvas() on
// the previous resolution was discarded, surfacing as the "+ button does
// nothing" bug Mason reported.
let nullProjectFallbackStore: ReturnType<typeof createCanvasStore> | null = null;

export function hasProjectCanvasStore(projectId: string | null): boolean {
  return projectId !== null && projectCanvasStores.has(projectId);
}

export function getProjectCanvasStore(projectId: string | null): ReturnType<typeof createCanvasStore> {
  if (!projectId) {
    if (!nullProjectFallbackStore) nullProjectFallbackStore = createCanvasStore();
    return nullProjectFallbackStore;
  }
  let store = projectCanvasStores.get(projectId);
  if (!store) {
    store = createCanvasStore();
    projectCanvasStores.set(projectId, store);
  }
  return store;
}

/** Return all known project IDs that have canvas stores (for cross-store search). */
export function getKnownProjectIds(): string[] {
  return Array.from(projectCanvasStores.keys());
}

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const getStore = () =>
    api.context.mode === 'app' ? useAppCanvasStore : getProjectCanvasStore(api.context.projectId ?? null);

  // Wire up the canvas query provider so other plugins can query widgets via api.canvas.queryWidgets()
  setCanvasQueryProvider((filter?: CanvasWidgetFilter) => {
    const store = getStore();
    return store.getState().queryViews(filter);
  });
  ctx.subscriptions.push({ dispose: () => setCanvasQueryProvider(null) });

  const addAgentCmd = api.commands.register('add-agent-view', () => {
    const store = getStore();
    store.getState().addView('agent', { x: 200, y: 200 });
  });
  ctx.subscriptions.push(addAgentCmd);

  const addFileCmd = api.commands.register('add-file-view', () => {
    const store = getStore();
    store.getState().addPluginView('files', 'plugin:files:file-viewer', 'File Viewer', { x: 300, y: 300 }, undefined, { width: 560, height: 480 });
  });
  ctx.subscriptions.push(addFileCmd);

  const addGitDiffCmd = api.commands.register('add-git-diff-view', () => {
    const store = getStore();
    store.getState().addPluginView('git', 'plugin:git:git-status', 'Git Status', { x: 250, y: 250 });
  });
  ctx.subscriptions.push(addGitDiffCmd);

  const addTerminalCmd = api.commands.register('add-terminal-view', () => {
    const store = getStore();
    store.getState().addPluginView('terminal', 'plugin:terminal:shell', 'Terminal', { x: 300, y: 200 }, undefined, { width: 480, height: 360 });
  });
  ctx.subscriptions.push(addTerminalCmd);

  const addAnchorCmd = api.commands.register('add-anchor-view', () => {
    const store = getStore();
    store.getState().addView('anchor', { x: 250, y: 250 });
  });
  ctx.subscriptions.push(addAnchorCmd);

  const resetCmd = api.commands.register('reset-viewport', () => {
    const store = getStore();
    store.getState().setViewport({ panX: 0, panY: 0, zoom: 1 });
  });
  ctx.subscriptions.push(resetCmd);
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

export function MainPanel({ api }: { api: PluginAPI }) {
  const isAppMode = api.context.mode === 'app';
  const store = isAppMode ? useAppCanvasStore : getProjectCanvasStore(api.context.projectId ?? null);
  const storage = isAppMode ? api.storage.global : api.storage.projectLocal;

  const canvases = store((s) => s.canvases);
  const activeCanvasId = store((s) => s.activeCanvasId);
  const views = store((s) => s.views);
  const viewport = store((s) => s.viewport);
  const zoomedViewId = store((s) => s.zoomedViewId);
  const selectedViewId = store((s) => s.selectedViewId);
  const selectedViewIds = store((s) => s.selectedViewIds);
  const loaded = store((s) => s.loaded);
  const wiresLoaded = store((s) => s.wiresLoaded);
  const wireDefinitions = store((s) => s.wireDefinitions);
  const minimapAutoHide = store((s) => s.minimapAutoHide);
  const elkAlgorithm = store((s) => s.elkAlgorithm);
  const elkDirection = store((s) => s.elkDirection);
  const layoutCenterId = store((s) => s.layoutCenterId);
  const bindings = useMcpBindingStore((s) => s.bindings);
  const settingsKey = `${isAppMode ? 'app' : api.context.projectId}:canvas`;
  const bidirectionalWires = usePluginStore(
    (s) => (s.pluginSettings[settingsKey]?.['bidirectional-wires'] as boolean) ?? false,
  );
  const createBidirectionalWires = usePluginStore(
    (s) => (s.pluginSettings[settingsKey]?.['create-bidirectional-wires'] as boolean) ?? true,
  );

  // Dynamic title: show active canvas tab name
  const activeCanvasName = canvases.find((c) => c.id === activeCanvasId)?.name;
  useEffect(() => {
    if (activeCanvasName) {
      api.window.setTitle(activeCanvasName);
    } else {
      api.window.resetTitle();
    }
  }, [api, activeCanvasName]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { findCanvasPopout } = usePopouts();

  // Load persisted state (or remote canvas state for annex projects)
  const projectId = api.context.projectId;
  const isRemote = projectId ? isRemoteProjectId(projectId) : false;
  const activeHostId = useUIStore((s) => s.activeHostId);
  const isRemoteApp = isAppMode && !!activeHostId;
  useEffect(() => {
    // App-mode with active satellite: hydrate from remote app canvas state
    if (isRemoteApp && activeHostId) {
      const remoteState = useRemoteProjectStore.getState().remoteAppCanvasState[activeHostId];
      if (remoteState) {
        store.getState().hydrateFromRemote(remoteState.canvases, remoteState.activeCanvasId, remoteState.wireDefinitions);
        return;
      }
    }
    if (isRemote && projectId) {
      const remoteState = useRemoteProjectStore.getState().remoteCanvasState[projectId];
      if (remoteState) {
        store.getState().hydrateFromRemote(remoteState.canvases, remoteState.activeCanvasId, remoteState.wireDefinitions);
        return;
      }
    }
    // Await loadCanvas before loadWires so that wire reconciliation has
    // access to the loaded canvas views.
    (async () => {
      await store.getState().loadCanvas(storage);
      await store.getState().loadWires(storage);
    })();
  }, [store, storage, isRemote, projectId, isRemoteApp, activeHostId]);

  // Subscribe to live remote canvas state updates (project-level)
  useEffect(() => {
    if (!isRemote || !projectId) return;
    let prevState = useRemoteProjectStore.getState().remoteCanvasState[projectId];
    return useRemoteProjectStore.subscribe((state) => {
      const newState = state.remoteCanvasState[projectId];
      if (newState && newState !== prevState && store.getState().loaded) {
        prevState = newState;
        store.getState().hydrateFromRemote(newState.canvases, newState.activeCanvasId, newState.wireDefinitions);
      }
    });
  }, [store, isRemote, projectId]);

  // Subscribe to live remote app canvas state updates (app-level satellite)
  useEffect(() => {
    if (!isRemoteApp || !activeHostId) return;
    let prevState = useRemoteProjectStore.getState().remoteAppCanvasState[activeHostId];
    return useRemoteProjectStore.subscribe((state) => {
      const newState = state.remoteAppCanvasState[activeHostId];
      if (newState && newState !== prevState && store.getState().loaded) {
        prevState = newState;
        store.getState().hydrateFromRemote(newState.canvases, newState.activeCanvasId, newState.wireDefinitions);
      }
    });
  }, [store, isRemoteApp, activeHostId]);

  // Ref for current live bindings — used by removal handlers to unbind MCP connections.
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  // Debounced auto-save (skip for remote projects/app — state is owned by satellite).
  // Wire definitions are saved from the canvas store (not from live MCP bindings),
  // so wires survive agent sleep/wake cycles.
  const scheduleSave = useCallback(() => {
    if (isRemote || isRemoteApp) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      store.getState().saveCanvas(storage);
      store.getState().saveWires(storage);
    }, 500);
  }, [store, storage, isRemote, isRemoteApp]);

  useEffect(() => {
    if (!loaded || !wiresLoaded) return;
    scheduleSave();
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [canvases, views, viewport, zoomedViewId, wireDefinitions, minimapAutoHide, elkAlgorithm, elkDirection, layoutCenterId, loaded, wiresLoaded, scheduleSave]);

  // ── Agent wake reconciliation ────────────────────────────────────
  // When an agent wakes up (bindings appear in MCP store that match wire
  // definitions), we don't need to do anything — the binding already exists.
  // But when a previously-sleeping agent's bindings were cleaned up by the
  // main process, we recreate them from wire definitions so wires reconnect.
  // Uses exponential backoff per wire to avoid spamming failed bind attempts.
  //
  // Wire definitions and bindings are read from refs to avoid resetting
  // timers on every state change (which would prevent reconnection).
  const wireDefsRef = useRef(wireDefinitions);
  wireDefsRef.current = wireDefinitions;
  const wireBackoffRef = useRef<Map<string, number>>(new Map());
  const wireBackoffTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  useEffect(() => {
    if (!loaded) return;

    const reconcile = () => {
      const defs = wireDefsRef.current;
      const currentBindings = bindingsRef.current;
      if (defs.length === 0) return;

      const liveKeys = new Set(currentBindings.map((b) => `${b.agentId}\0${b.targetId}`));
      const backoff = wireBackoffRef.current;
      const timers = wireBackoffTimerRef.current;

      for (const def of defs) {
        const key = `${def.agentId}\0${def.targetId}`;
        if (liveKeys.has(key)) {
          // Binding exists — clear any backoff state
          backoff.delete(key);
          const timer = timers.get(key);
          if (timer) { clearTimeout(timer); timers.delete(key); }
          continue;
        }
        // Already has a pending retry timer — skip
        if (timers.has(key)) continue;

        const delay = backoff.get(key) || 0;
        const attempt = () => {
          timers.delete(key);
          window.clubhouse.mcpBinding.bind(def.agentId, {
            targetId: def.targetId,
            targetKind: def.targetKind,
            label: def.label,
            agentName: def.agentName,
            targetName: def.targetName,
            projectName: def.projectName,
          }).catch(() => {
            // Exponential backoff: 1s → 2s → 4s → 8s → ... cap at 60s
            const next = Math.min((delay || 1000) * 2, 60_000);
            backoff.set(key, next);
          });
        };

        if (delay === 0) {
          attempt();
          backoff.set(key, 1000);
        } else {
          timers.set(key, setTimeout(attempt, delay));
        }
      }
    };

    // Initial reconciliation + periodic re-check (avoids resetting timers
    // on every wireDefinitions/bindings state change)
    reconcile();
    const interval = setInterval(reconcile, 2000);

    return () => {
      clearInterval(interval);
      for (const timer of wireBackoffTimerRef.current.values()) clearTimeout(timer);
      wireBackoffTimerRef.current.clear();
    };
  }, [loaded]);

  // Broadcast canvas state changes to pop-out windows and annex clients
  // (skip for remote projects/app — the satellite broadcasts its own state)
  const scope = isAppMode ? 'global' : 'project';
  useEffect(() => {
    if (!loaded || isRemote || isRemoteApp) return;
    // Only broadcast from the main window, not from pop-outs
    if (window.clubhouse.window.isPopout()) return;
    broadcastCanvasState(
      store,
      activeCanvasId,
      isAppMode ? undefined : api.context.projectId,
      scope,
    );
  }, [store, activeCanvasId, canvases, views, viewport, zoomedViewId, loaded, isAppMode, isRemote, isRemoteApp, api, scope]);

  // ── Remote mutation helper ──────────────────────────────────────

  /**
   * For remote projects, forward mutations to the satellite for persistence.
   *
   * Mutations are always applied locally first (optimistic) so the controller
   * UI updates immediately.  The satellite processes the mutation, persists it,
   * and broadcasts the authoritative state back.  On hydration the satellite's
   * state replaces the local optimistic state — this is safe because the
   * mutation result is identical on both sides for modify-operations (move,
   * resize, update, remove) and for create-operations the satellite's version
   * simply has a different view ID at the same position.
   */
  const remoteForward = useCallback((mutation: CanvasMutation): void => {
    if (!isRemote || !projectId) return;
    sendRemoteCanvasMutation(projectId, activeCanvasId, scope, mutation);
  }, [isRemote, projectId, activeCanvasId, scope]);

  // ── Pop-out handler ─────────────────────────────────────────────

  const handlePopOutCanvas = useCallback(async (canvasId: string, canvasName: string) => {
    await window.clubhouse.window.createPopout({
      type: 'canvas',
      canvasId,
      projectId: isAppMode ? undefined : api.context.projectId,
      title: `Canvas — ${canvasName}`,
    });
  }, [isAppMode, api]);

  // ── Canvas tab bar callbacks ───────────────────────────────────

  const handleSelectCanvas = useCallback((canvasId: string) => {
    // Tab switching is local (controller may browse different tabs than satellite)
    store.getState().setActiveCanvas(canvasId);
  }, [store]);

  const handleAddCanvas = useCallback(() => {
    remoteForward({ type: 'addCanvas' });
    store.getState().addCanvas();
  }, [store, remoteForward]);

  const handleAddFromBlueprint = useCallback(() => {
    useUIStore.getState().openBlueprintGallery();
  }, []);

  const handleRemoveCanvas = useCallback((canvasId: string) => {
    remoteForward({ type: 'removeCanvas', canvasId });
    // Unbind all MCP wires and remove wire definitions for views on this canvas
    const canvas = store.getState().canvases.find((c) => c.id === canvasId);
    if (canvas) {
      const currentBindings = bindingsRef.current;
      const unbind = useMcpBindingStore.getState().unbind;
      const { removeWireDefinition } = store.getState();
      const seen = new Set<string>();
      for (const view of canvas.views) {
        for (const b of findBindingsForView(view, currentBindings)) {
          const key = `${b.agentId}:${b.targetId}`;
          if (!seen.has(key)) {
            seen.add(key);
            unbind(b.agentId, b.targetId);
            removeWireDefinition(b.agentId, b.targetId);
          }
        }
      }
    }
    store.getState().removeCanvas(canvasId);
  }, [store, remoteForward]);

  const handleRenameCanvas = useCallback((canvasId: string, name: string) => {
    remoteForward({ type: 'renameCanvas', canvasId, name });
    store.getState().renameCanvas(canvasId, name);
  }, [store, remoteForward]);

  // ── Blueprint export ──────────────────────────────────────────
  const [exportCanvasId, setExportCanvasId] = useState<string | null>(null);

  const handleExportBlueprint = useCallback((canvasId: string) => {
    setExportCanvasId(canvasId);
  }, []);

  // ── Workspace callbacks ────────────────────────────────────────

  // Viewport and selection are always local (controller navigation state)
  const handleViewportChange = useCallback((vp: typeof viewport) => {
    store.getState().setViewport(vp);
  }, [store]);

  const handleAddView = useCallback((type: CanvasViewType, position: { x: number; y: number }) => {
    remoteForward({ type: 'addView', viewType: type, position });
    store.getState().addView(type, position);
  }, [store, remoteForward]);

  const handleAddPluginView = useCallback((
    pluginId: string, qualifiedType: string, label: string,
    position: { x: number; y: number }, defaultSize?: { width: number; height: number },
  ) => {
    remoteForward({ type: 'addPluginView', pluginId, qualifiedType, label, position, defaultSize });
    store.getState().addPluginView(pluginId, qualifiedType, label, position, undefined, defaultSize);
  }, [store, remoteForward]);

  const handleRemoveView = useCallback((viewId: string) => {
    remoteForward({ type: 'removeView', viewId });
    // Unbind any MCP wires and remove wire definitions for this view
    const view = store.getState().activeCanvas().views.find((v) => v.id === viewId);
    if (view) {
      const stale = findBindingsForView(view, bindingsRef.current);
      const unbind = useMcpBindingStore.getState().unbind;
      const { removeWireDefinition } = store.getState();
      for (const b of stale) {
        unbind(b.agentId, b.targetId);
        removeWireDefinition(b.agentId, b.targetId);
      }
    }
    store.getState().removeView(viewId);
  }, [store, remoteForward]);

  const handleMoveView = useCallback((viewId: string, position: { x: number; y: number }) => {
    remoteForward({ type: 'moveView', viewId, position });
    store.getState().moveView(viewId, position);
  }, [store, remoteForward]);

  const handleResizeView = useCallback((viewId: string, size: { width: number; height: number }) => {
    remoteForward({ type: 'resizeView', viewId, size });
    store.getState().resizeView(viewId, size);
  }, [store, remoteForward]);

  const handleFocusView = useCallback((viewId: string) => {
    remoteForward({ type: 'focusView', viewId });
    store.getState().focusView(viewId);
  }, [store, remoteForward]);

  const handleUpdateView = useCallback((viewId: string, updates: Partial<any>) => {
    remoteForward({ type: 'updateView', viewId, updates });
    store.getState().updateView(viewId, updates);
  }, [store, remoteForward]);

  // LB-M68: Spawn a NEW agent card adjacent to a parent agent card. Used by
  // AgentCanvasView's "+ New Agent" picker so the new agent lands as a sibling
  // of the parent (instead of overwriting the parent). Position is computed
  // from the parent's bounds and the existing canvas state, then snapped to
  // grid. Persistence is handled by the existing scheduleSave debounce.
  const handleCreateAgentCard = useCallback((
    parentView: AgentCanvasView,
    agent: { id: string; name: string; projectId?: string; orchestrator?: string; model?: string },
  ) => {
    const existingViews = store.getState().views;
    const newSize = parentView.size; // mirror the parent dimensions for visual consistency
    const position = computeAdjacentPosition(
      parentView.position,
      parentView.size,
      newSize,
      existingViews,
    );

    remoteForward({ type: 'addView', viewType: 'agent', position });
    const newViewId = store.getState().addView('agent', position);
    if (!newViewId) return;

    const project = useProjectStore.getState().projects.find((p) => p.id === agent.projectId);
    const displayName = agent.name || agent.id;
    const updates: Partial<AgentCanvasView> = {
      agentId: agent.id,
      projectId: agent.projectId,
      title: displayName,
      displayName,
      size: newSize,
      metadata: {
        agentId: agent.id,
        projectId: agent.projectId ?? null,
        agentName: agent.name ?? null,
        projectName: project?.name ?? null,
        orchestrator: agent.orchestrator ?? null,
        model: agent.model ?? null,
      },
    };
    remoteForward({ type: 'updateView', viewId: newViewId, updates: updates as Record<string, unknown> });
    store.getState().updateView(newViewId, updates);
    // Resize the new card to match the parent if the default differs.
    if (newSize.width !== undefined && newSize.height !== undefined) {
      remoteForward({ type: 'resizeView', viewId: newViewId, size: newSize });
      store.getState().resizeView(newViewId, newSize);
    }
  }, [store, remoteForward]);

  const handleZoomView = useCallback((viewId: string | null) => {
    remoteForward({ type: 'zoomView', viewId });
    store.getState().zoomView(viewId);
  }, [store, remoteForward]);

  const handleSelectView = useCallback((viewId: string | null) => {
    remoteForward({ type: 'selectView', viewId });
    store.getState().selectView(viewId);
  }, [store, remoteForward]);

  const handleMoveViews = useCallback((positions: Map<string, { x: number; y: number }>) => {
    const posObj = Object.fromEntries(positions);
    remoteForward({ type: 'moveViews', positions: posObj });
    store.getState().moveViews(positions);
  }, [store, remoteForward]);

  const handleToggleSelectView = useCallback((viewId: string) => {
    store.getState().toggleSelectView(viewId);
  }, [store]);

  const handleSetSelectedViewIds = useCallback((ids: string[]) => {
    store.getState().setSelectedViewIds(ids);
  }, [store]);

  const handleClearSelection = useCallback(() => {
    store.getState().clearSelection();
  }, [store]);

  const handleRemoveZone = useCallback((zoneId: string, removeContents: boolean) => {
    remoteForward({ type: 'removeZone', zoneId, removeContents });
    // Unbind any MCP wires and remove wire definitions for zone contents
    const zone = store.getState().activeCanvas().views.find((v) => v.id === zoneId && v.type === 'zone');
    if (zone) {
      const unbind = useMcpBindingStore.getState().unbind;
      const { removeWireDefinition } = store.getState();
      // Unbind wires for contained views if they're being removed
      if (removeContents && 'containedViewIds' in zone) {
        const contained = (zone as any).containedViewIds as string[];
        for (const viewId of contained) {
          const view = store.getState().activeCanvas().views.find((v) => v.id === viewId);
          if (view) {
            const stale = findBindingsForView(view, bindingsRef.current);
            for (const b of stale) {
              unbind(b.agentId, b.targetId);
              removeWireDefinition(b.agentId, b.targetId);
            }
          }
        }
      }
    }
    store.getState().removeZone(zoneId, removeContents);
  }, [store, remoteForward]);

  const handleUpdateZoneTheme = useCallback((zoneId: string, themeId: string) => {
    remoteForward({ type: 'updateZoneTheme', zoneId, themeId });
    store.getState().updateZoneTheme(zoneId, themeId);
  }, [store, remoteForward]);

  if (!loaded) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading canvas...');
  }

  const canvasPopout = findCanvasPopout(activeCanvasId);
  const activeCanvas = canvases.find((c) => c.id === activeCanvasId);

  return React.createElement('div', { className: 'flex flex-col h-full w-full', 'data-testid': 'canvas-panel' },
    React.createElement(CanvasTabBar, {
      canvases,
      activeCanvasId,
      onSelectCanvas: handleSelectCanvas,
      onAddCanvas: handleAddCanvas,
      onAddFromBlueprint: handleAddFromBlueprint,
      onRemoveCanvas: handleRemoveCanvas,
      onRenameCanvas: handleRenameCanvas,
      onPopOutCanvas: handlePopOutCanvas,
      onExportBlueprint: handleExportBlueprint,
    }),
    canvasPopout
      ? React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(PoppedOutPlaceholder, {
            type: 'canvas',
            name: activeCanvas?.name,
            windowId: canvasPopout.windowId,
          }),
        )
      : React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(CanvasWorkspace, {
            views,
            viewport,
            zoomedViewId,
            selectedViewId,
            selectedViewIds,
            wireDefinitions,
            onAddWireDefinition: (entry: McpBindingEntry) => {
              let wireEntry = entry;
              if (entry.targetKind === 'group-project' && !entry.disabledTools?.length) {
                const projects = useGroupProjectStore.getState().projects;
                const project = projects[entry.targetId];
                const defaults = project?.metadata?.defaultDisabledTools as string[] | undefined;
                if (!defaults) {
                  // No explicit defaults set — use the all-disabled default (new projects start locked down)
                  const allAdvanced = ['shoulder_tap', 'broadcast', 'wake_agent', 'start_polling', 'stop_polling', 'clear_agent', 'compact_agent', 'clear_topic', 'delete_messages'];
                  wireEntry = { ...entry, disabledTools: allAdvanced };
                  void window.clubhouse.mcpBinding.setDisabledTools(entry.agentId, entry.targetId, allAdvanced);
                } else if (defaults.length > 0) {
                  wireEntry = { ...entry, disabledTools: defaults };
                  void window.clubhouse.mcpBinding.setDisabledTools(entry.agentId, entry.targetId, defaults);
                }
              }
              store.getState().addWireDefinition(wireEntry);
            },
            onRemoveWireDefinition: (agentId: string, targetId: string) => store.getState().removeWireDefinition(agentId, targetId),
            onUpdateWireDefinition: (agentId: string, targetId: string, updates: Partial<McpBindingEntry>) => store.getState().updateWireDefinition(agentId, targetId, updates),
            api,
            onViewportChange: handleViewportChange,
            onAddView: handleAddView,
            onAddPluginView: handleAddPluginView,
            onRemoveView: handleRemoveView,
            onMoveView: handleMoveView,
            onMoveViews: handleMoveViews,
            onResizeView: handleResizeView,
            onFocusView: handleFocusView,
            onUpdateView: handleUpdateView,
            onCreateAgentCard: handleCreateAgentCard,
            onZoomView: handleZoomView,
            onSelectView: handleSelectView,
            onToggleSelectView: handleToggleSelectView,
            onSetSelectedViewIds: handleSetSelectedViewIds,
            onClearSelection: handleClearSelection,
            onRemoveZone: handleRemoveZone,
            onUpdateZoneTheme: handleUpdateZoneTheme,
            minimapAutoHide,
            onMinimapAutoHideChange: (value: boolean) => store.getState().setMinimapAutoHide(value),
            elkAlgorithm,
            elkDirection,
            onElkAlgorithmChange: (value: 'layered' | 'radial' | 'force' | 'mrtree') => store.getState().setElkAlgorithm(value),
            onElkDirectionChange: (value: 'RIGHT' | 'DOWN' | 'LEFT' | 'UP') => store.getState().setElkDirection(value),
            layoutCenterId,
            onSetLayoutCenterId: (value: string | null) => store.getState().setLayoutCenterId(value),
            bidirectionalWires,
            createBidirectionalWires,
          }),
        ),
    // Blueprint export dialog
    exportCanvasId ? React.createElement(ExportBlueprintDialog, {
      canvas: canvases.find((c) => c.id === exportCanvasId) ?? canvases[0],
      agents: useAgentStore.getState().agents,
      projects: Object.fromEntries(useProjectStore.getState().projects.map((p) => [p.id, p])),
      wireDefinitions,
      projectId: isAppMode ? undefined : api.context.projectId ?? undefined,
      projectPath: (() => {
        const pid = isAppMode ? undefined : api.context.projectId;
        if (!pid) return undefined;
        return useProjectStore.getState().projects.find((p) => p.id === pid)?.path;
      })(),
      appVersion: undefined, // Populated asynchronously if needed
      onClose: () => setExportCanvasId(null),
    }) : null,
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
