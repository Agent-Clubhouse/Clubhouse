import React, { useEffect, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule, CanvasWidgetFilter } from '../../../../shared/plugin-types';
import type { CanvasViewType } from './canvas-types';
import { createCanvasStore } from './canvas-store';
import { CanvasTabBar } from './CanvasTabBar';
import { CanvasWorkspace } from './CanvasWorkspace';
import { setCanvasQueryProvider } from '../../plugin-api-canvas';
import { broadcastCanvasState } from './canvas-sync';
import { PoppedOutPlaceholder } from '../../../features/popout/PoppedOutPlaceholder';
import { usePopouts } from '../../../hooks/usePopouts';

// App-mode canvas store: single instance shared across all projects
export const useAppCanvasStore = createCanvasStore();

// Project-mode canvas stores: one per project, keyed by projectId
const projectCanvasStores = new Map<string, ReturnType<typeof createCanvasStore>>();

export function hasProjectCanvasStore(projectId: string | null): boolean {
  return projectId !== null && projectCanvasStores.has(projectId);
}

export function getProjectCanvasStore(projectId: string | null): ReturnType<typeof createCanvasStore> {
  if (!projectId) return createCanvasStore(); // transient fallback
  let store = projectCanvasStores.get(projectId);
  if (!store) {
    store = createCanvasStore();
    projectCanvasStores.set(projectId, store);
  }
  return store;
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

  // Load persisted state
  useEffect(() => {
    store.getState().loadCanvas(storage);
  }, [store, storage]);

  // Debounced auto-save
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      store.getState().saveCanvas(storage);
    }, 500);
  }, [store, storage]);

  useEffect(() => {
    if (!loaded) return;
    scheduleSave();
  }, [canvases, views, viewport, zoomedViewId, loaded, scheduleSave]);

  // Broadcast canvas state changes to pop-out windows
  useEffect(() => {
    if (!loaded) return;
    // Only broadcast from the main window, not from pop-outs
    if (window.clubhouse.window.isPopout()) return;
    broadcastCanvasState(store, activeCanvasId);
  }, [store, activeCanvasId, canvases, views, viewport, zoomedViewId, loaded]);

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
    store.getState().setActiveCanvas(canvasId);
  }, [store]);

  const handleAddCanvas = useCallback(() => {
    store.getState().addCanvas();
  }, [store]);

  const handleRemoveCanvas = useCallback((canvasId: string) => {
    store.getState().removeCanvas(canvasId);
  }, [store]);

  const handleRenameCanvas = useCallback((canvasId: string, name: string) => {
    store.getState().renameCanvas(canvasId, name);
  }, [store]);

  // ── Workspace callbacks ────────────────────────────────────────

  const handleViewportChange = useCallback((vp: typeof viewport) => {
    store.getState().setViewport(vp);
  }, [store]);

  const handleAddView = useCallback((type: CanvasViewType, position: { x: number; y: number }) => {
    store.getState().addView(type, position);
  }, [store]);

  const handleAddPluginView = useCallback((
    pluginId: string, qualifiedType: string, label: string,
    position: { x: number; y: number }, defaultSize?: { width: number; height: number },
  ) => {
    store.getState().addPluginView(pluginId, qualifiedType, label, position, undefined, defaultSize);
  }, [store]);

  const handleRemoveView = useCallback((viewId: string) => {
    store.getState().removeView(viewId);
  }, [store]);

  const handleMoveView = useCallback((viewId: string, position: { x: number; y: number }) => {
    store.getState().moveView(viewId, position);
  }, [store]);

  const handleResizeView = useCallback((viewId: string, size: { width: number; height: number }) => {
    store.getState().resizeView(viewId, size);
  }, [store]);

  const handleFocusView = useCallback((viewId: string) => {
    store.getState().focusView(viewId);
  }, [store]);

  const handleUpdateView = useCallback((viewId: string, updates: Partial<any>) => {
    store.getState().updateView(viewId, updates);
  }, [store]);

  const handleZoomView = useCallback((viewId: string | null) => {
    store.getState().zoomView(viewId);
  }, [store]);

  const handleSelectView = useCallback((viewId: string | null) => {
    store.getState().selectView(viewId);
  }, [store]);

  const handleMoveViews = useCallback((positions: Map<string, { x: number; y: number }>) => {
    store.getState().moveViews(positions);
  }, [store]);

  const handleToggleSelectView = useCallback((viewId: string) => {
    store.getState().toggleSelectView(viewId);
  }, [store]);

  const handleSetSelectedViewIds = useCallback((ids: string[]) => {
    store.getState().setSelectedViewIds(ids);
  }, [store]);

  const handleClearSelection = useCallback(() => {
    store.getState().clearSelection();
  }, [store]);

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
      onRemoveCanvas: handleRemoveCanvas,
      onRenameCanvas: handleRenameCanvas,
      onPopOutCanvas: handlePopOutCanvas,
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
            onZoomView: handleZoomView,
            onSelectView: handleSelectView,
            onToggleSelectView: handleToggleSelectView,
            onSetSelectedViewIds: handleSetSelectedViewIds,
            onClearSelection: handleClearSelection,
          }),
        ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
