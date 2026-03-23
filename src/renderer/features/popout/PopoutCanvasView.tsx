/**
 * Pop-out canvas view — a follower viewport into the main window's canvas state.
 *
 * Architecture:
 * - The main window's canvas Zustand store is the single source of truth.
 * - This view subscribes to canvas state changes via IPC and renders the
 *   same CanvasWorkspace component using synced state.
 * - All mutations (addView, moveView, setViewport, etc.) are forwarded to
 *   the main window via IPC — no local state modification.
 * - Periodic reconciliation (every 30 seconds) catches any missed events.
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { CanvasWorkspace } from '../../plugins/builtin/canvas/CanvasWorkspace';
import type { CanvasView, CanvasViewType, Viewport, Position, Size } from '../../plugins/builtin/canvas/canvas-types';
import { clampViewport } from '../../plugins/builtin/canvas/canvas-operations';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { createWidgetsAPI } from '../../plugins/plugin-api-ui';
import type { PluginAPI, AgentsAPI, ProjectsAPI, Disposable, AgentInfo, PluginAgentDetailedStatus } from '../../../shared/plugin-types';
import type { CanvasMutation } from '../../../shared/types';

interface PopoutCanvasViewProps {
  canvasId?: string;
  projectId?: string;
}

const RECONCILE_INTERVAL_MS = 30_000;

/**
 * Create a minimal PluginAPI facade for canvas view components in the pop-out.
 * Only the subset used by canvas views is implemented; other methods throw.
 */
function createPopoutApi(projectId?: string): PluginAPI {
  const mode = projectId ? 'project' : 'app';

  const agents: AgentsAPI = {
    list(): AgentInfo[] {
      const allAgents = useAgentStore.getState().agents;
      return Object.values(allAgents)
        .filter((a) => !projectId || a.projectId === projectId)
        .map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          status: a.status,
          color: a.color,
          icon: a.icon,
          exitCode: a.exitCode,
          mission: a.mission,
          projectId: a.projectId,
          branch: a.branch,
          worktreePath: a.worktreePath,
          model: a.model,
          parentAgentId: a.parentAgentId,
          orchestrator: a.orchestrator,
          freeAgentMode: a.freeAgentMode,
        }));
    },
    getDetailedStatus(agentId: string): PluginAgentDetailedStatus | null {
      const ds = useAgentStore.getState().agentDetailedStatus[agentId];
      return ds ?? null;
    },
    onAnyChange(callback: () => void): Disposable {
      const unsub = useAgentStore.subscribe(callback);
      return { dispose: unsub };
    },
    onStatusChange(callback: (agentId: string, status: string, prevStatus: string) => void): Disposable {
      let prev: Record<string, string> = {};
      const unsub = useAgentStore.subscribe((state) => {
        for (const [id, agent] of Object.entries(state.agents)) {
          if (prev[id] && prev[id] !== agent.status) {
            callback(id, agent.status, prev[id]);
          }
        }
        prev = Object.fromEntries(Object.entries(state.agents).map(([id, a]) => [id, a.status]));
      });
      return { dispose: unsub };
    },
    // Stubs for methods not needed in pop-out
    createDurable: () => Promise.reject(new Error('Not available in pop-out')),
    runQuick: () => Promise.reject(new Error('Not available in pop-out')),
    kill: () => Promise.reject(new Error('Not available in pop-out')),
    resume: () => Promise.reject(new Error('Not available in pop-out')),
    listCompleted: () => [],
    dismissCompleted: () => {},
    getModelOptions: () => Promise.resolve([]),
    listOrchestrators: () => [],
    checkOrchestratorAvailability: () => Promise.resolve({ available: false }),
    listSessions: () => Promise.resolve([]),
    readSessionTranscript: () => Promise.resolve(null),
    getSessionSummary: () => Promise.resolve(null),
    spawnCompanion: () => Promise.reject(new Error('Not available in popout')),
    getCompanionStatus: () => Promise.resolve('none' as const),
    getCompanionWorkspace: () => Promise.reject(new Error('Not available in popout')),
  };

  const projects: ProjectsAPI = {
    list() {
      return useProjectStore.getState().projects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
      }));
    },
    getActive() {
      const state = useProjectStore.getState();
      const active = state.projects.find((p) => p.id === state.activeProjectId);
      return active ? { id: active.id, name: active.name, path: active.path } : null;
    },
  };

  const widgets = createWidgetsAPI();

  // Return a minimal API — only the parts used by canvas view components
  return {
    context: {
      pluginId: 'canvas',
      mode,
      projectId,
      projectPath: projectId
        ? useProjectStore.getState().projects.find((p) => p.id === projectId)?.path
        : undefined,
    },
    agents,
    projects,
    widgets,
    // Minimal stubs for APIs used by some canvas views
    project: {
      readFile: (): Promise<string | null> => Promise.resolve(null),
      listFiles: (): Promise<string[]> => Promise.resolve([]),
      getProjectPath: (): string | null => null,
      getProjectName: (): string | null => null,
    },
    settings: {
      get: (_key: string): undefined => undefined,
      getAll: (): Record<string, unknown> => ({}),
      set: (_key: string, _value: unknown): void => {},
      onChange: (_cb: (key: string, value: unknown) => void): Disposable => ({ dispose: () => {} }),
    },
  } as unknown as PluginAPI;
}

export function PopoutCanvasView({ canvasId, projectId }: PopoutCanvasViewProps) {
  const [views, setViews] = useState<CanvasView[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ panX: 0, panY: 0, zoom: 1 });
  const [zoomedViewId, setZoomedViewId] = useState<string | null>(null);
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  const [selectedViewIds, setSelectedViewIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadDurableAgents = useAgentStore((s) => s.loadDurableAgents);

  const scope = projectId ? 'project-local' : 'global';

  const api = useMemo(() => createPopoutApi(projectId), [projectId]);

  // ── Initial state load via IPC ────────────────────────────────────

  useEffect(() => {
    if (!canvasId) {
      setError('No canvas ID specified');
      setLoading(false);
      return;
    }

    let cancelled = false;

    (async () => {
      await loadProjects();

      if (projectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
        if (project) {
          await loadDurableAgents(projectId, project.path);
        }
      }

      const snapshot = await window.clubhouse.window.getCanvasState(canvasId, scope, projectId);
      if (cancelled) return;

      if (snapshot) {
        setViews(snapshot.views as CanvasView[]);
        setViewport(clampViewport(snapshot.viewport));
        setZoomedViewId(snapshot.zoomedViewId);
      } else {
        setError(`Canvas "${canvasId}" not found`);
      }
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        setError(`Failed to load canvas: ${err}`);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [canvasId, projectId, scope, loadProjects, loadDurableAgents]);

  // ── Subscribe to canvas state changes from main window ────────────

  useEffect(() => {
    if (!canvasId) return;
    const remove = window.clubhouse.window.onCanvasStateChanged((state) => {
      if (state.canvasId !== canvasId) return;
      setViews(state.views as CanvasView[]);
      setViewport(clampViewport(state.viewport));
      setZoomedViewId(state.zoomedViewId);
    });
    return remove;
  }, [canvasId]);

  // ── Periodic reconciliation ───────────────────────────────────────

  useEffect(() => {
    if (!canvasId) return;
    const interval = setInterval(() => {
      window.clubhouse.window.getCanvasState(canvasId, scope, projectId).then((snapshot) => {
        if (snapshot) {
          setViews(snapshot.views as CanvasView[]);
          setViewport(clampViewport(snapshot.viewport));
          setZoomedViewId(snapshot.zoomedViewId);
        }
      }).catch(() => { /* silent — main window may be busy */ });
    }, RECONCILE_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [canvasId, scope, projectId]);

  // ── Mutation forwarding via IPC ───────────────────────────────────

  const sendMutation = useCallback((mutation: CanvasMutation) => {
    if (!canvasId) return;
    window.clubhouse.window.sendCanvasMutation(canvasId, scope, mutation, projectId);
  }, [canvasId, scope, projectId]);

  const handleViewportChange = useCallback((vp: Viewport) => {
    // Apply locally for responsiveness, then forward
    setViewport(vp);
    sendMutation({ type: 'setViewport', viewport: vp });
  }, [sendMutation]);

  const handleAddView = useCallback((type: CanvasViewType, position: Position) => {
    sendMutation({ type: 'addView', viewType: type, position });
  }, [sendMutation]);

  const handleAddPluginView = useCallback((
    pluginId: string, qualifiedType: string, label: string,
    position: Position, defaultSize?: { width: number; height: number },
  ) => {
    sendMutation({ type: 'addPluginView', pluginId, qualifiedType, label, position, defaultSize });
  }, [sendMutation]);

  const handleRemoveView = useCallback((viewId: string) => {
    sendMutation({ type: 'removeView', viewId });
  }, [sendMutation]);

  const handleMoveView = useCallback((viewId: string, position: Position) => {
    sendMutation({ type: 'moveView', viewId, position });
  }, [sendMutation]);

  const handleResizeView = useCallback((viewId: string, size: Size) => {
    sendMutation({ type: 'resizeView', viewId, size });
  }, [sendMutation]);

  const handleFocusView = useCallback((viewId: string) => {
    sendMutation({ type: 'focusView', viewId });
  }, [sendMutation]);

  const handleUpdateView = useCallback((viewId: string, updates: Partial<CanvasView>) => {
    sendMutation({ type: 'updateView', viewId, updates: updates as Record<string, unknown> });
  }, [sendMutation]);

  const handleZoomView = useCallback((viewId: string | null) => {
    sendMutation({ type: 'zoomView', viewId });
  }, [sendMutation]);

  const handleMoveViews = useCallback((positions: Map<string, Position>) => {
    // Forward each move as individual mutations
    for (const [viewId, position] of positions) {
      sendMutation({ type: 'moveView', viewId, position });
    }
  }, [sendMutation]);

  const handleToggleSelectView = useCallback((viewId: string) => {
    setSelectedViewIds((prev) =>
      prev.includes(viewId) ? prev.filter((id) => id !== viewId) : [...prev, viewId]
    );
  }, []);

  const handleClearSelection = useCallback(() => {
    setSelectedViewIds([]);
    setSelectedViewId(null);
  }, []);

  const handleRemoveZone = useCallback((zoneId: string, removeContents: boolean) => {
    sendMutation({ type: 'removeZone', zoneId, removeContents });
  }, [sendMutation]);

  const handleUpdateZoneTheme = useCallback((zoneId: string, themeId: string) => {
    sendMutation({ type: 'updateZoneTheme', zoneId, themeId });
  }, [sendMutation]);

  // ── Render ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-xs">
        Loading canvas...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full text-ctp-subtext0 text-sm">
        {error}
      </div>
    );
  }

  return (
    <div className="w-full h-full overflow-hidden" data-testid="popout-canvas-view">
      <CanvasWorkspace
        views={views}
        viewport={viewport}
        zoomedViewId={zoomedViewId}
        selectedViewId={selectedViewId}
        selectedViewIds={selectedViewIds}
        api={api}
        onViewportChange={handleViewportChange}
        onAddView={handleAddView}
        onAddPluginView={handleAddPluginView}
        onRemoveView={handleRemoveView}
        onMoveView={handleMoveView}
        onMoveViews={handleMoveViews}
        onResizeView={handleResizeView}
        onFocusView={handleFocusView}
        onUpdateView={handleUpdateView}
        onZoomView={handleZoomView}
        onSelectView={setSelectedViewId}
        onToggleSelectView={handleToggleSelectView}
        onSetSelectedViewIds={setSelectedViewIds}
        onClearSelection={handleClearSelection}
        onRemoveZone={handleRemoveZone}
        onUpdateZoneTheme={handleUpdateZoneTheme}
      />
    </div>
  );
}
