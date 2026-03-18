import React, { useEffect, useCallback, useRef } from 'react';
import type { PluginContext, PluginAPI, PluginModule } from '../../../../shared/plugin-types';
import type { CanvasViewType } from './canvas-types';
import { createCanvasStore } from './canvas-store';
import { CanvasTabBar } from './CanvasTabBar';
import { CanvasWorkspace } from './CanvasWorkspace';

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

  const addAgentCmd = api.commands.register('add-agent-view', () => {
    const store = getStore();
    store.getState().addView('agent', { x: 200, y: 200 });
  });
  ctx.subscriptions.push(addAgentCmd);

  const addFileCmd = api.commands.register('add-file-view', () => {
    const store = getStore();
    store.getState().addView('file', { x: 300, y: 300 });
  });
  ctx.subscriptions.push(addFileCmd);

  const addGitDiffCmd = api.commands.register('add-git-diff-view', () => {
    const store = getStore();
    store.getState().addView('git-diff', { x: 250, y: 250 });
  });
  ctx.subscriptions.push(addGitDiffCmd);

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
  const loaded = store((s) => s.loaded);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  if (!loaded) {
    return React.createElement('div', {
      className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs',
    }, 'Loading canvas...');
  }

  return React.createElement('div', { className: 'flex flex-col h-full w-full' },
    React.createElement(CanvasTabBar, {
      canvases,
      activeCanvasId,
      onSelectCanvas: handleSelectCanvas,
      onAddCanvas: handleAddCanvas,
      onRemoveCanvas: handleRemoveCanvas,
      onRenameCanvas: handleRenameCanvas,
    }),
    React.createElement('div', { className: 'flex-1 min-h-0' },
      React.createElement(CanvasWorkspace, {
        views,
        viewport,
        zoomedViewId,
        api,
        onViewportChange: handleViewportChange,
        onAddView: handleAddView,
        onRemoveView: handleRemoveView,
        onMoveView: handleMoveView,
        onResizeView: handleResizeView,
        onFocusView: handleFocusView,
        onUpdateView: handleUpdateView,
        onZoomView: handleZoomView,
      }),
    ),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
