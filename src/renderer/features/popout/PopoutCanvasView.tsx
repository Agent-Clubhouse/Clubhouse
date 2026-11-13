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
import type { AccessLevel } from '../../../shared/agent-access';
import React, { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import { CanvasWorkspace } from '../../plugins/builtin/canvas/CanvasWorkspace';
import type { CanvasView, CanvasViewType, Viewport, Position, Size } from '../../plugins/builtin/canvas/canvas-types';
import { clampViewport } from '../../plugins/builtin/canvas/canvas-operations';
import type { ZoneWireDefinition } from '../../plugins/builtin/canvas/zone-wire-store';
import { useAgentStore } from '../../stores/agentStore';
import { getAgentStatus, onChatStatusChange } from '../agents/agent-status-store';
import { useProjectStore } from '../../stores/projectStore';
import { createWidgetsAPI } from '../../plugins/plugin-api-ui';
import type { PluginAPI, AgentsAPI, ProjectsAPI, Disposable, AgentInfo, PluginAgentDetailedStatus } from '../../../shared/plugin-types';
import type { CanvasMutation } from '../../../shared/types';
import { useMcpBindingStore } from '../../stores/mcpBindingStore';
import type { CanvasPopoutReveal } from '../../../shared/canvas-index-types';
import { isCanvasTargetView } from '../../../shared/canvas-persistence';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { viewStructure } from '../../plugins/builtin/canvas/canvas-navigation-handoff';

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
      const ds = getAgentStatus(agentId);
      return ds ?? null;
    },
    onAnyChange(callback: () => void): Disposable {
      const unsub = useAgentStore.subscribe(callback);
      const unsubChat = onChatStatusChange(callback);
      return { dispose: () => { unsub(); unsubChat(); } };
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
    // Durable agent creation: write the config via IPC (works from any
    // renderer), spawn locally so the popout's own store/picker reflects
    // it immediately, then ask the main window to reload its durables so
    // its next broadcast doesn't overwrite our locally-added agent.
    createDurable: async (options: {
      projectId?: string;
      name: string;
      color: string;
      model?: string;
      useWorktree?: boolean;
      orchestrator?: string;
      freeAgentMode?: boolean;
      access?: AccessLevel;
      mcpIds?: string[];
    }): Promise<string> => {
      const targetProjectId = options.projectId || projectId;
      if (!targetProjectId) throw new Error('createDurable requires a project context');
      const project = useProjectStore.getState().projects.find((p) => p.id === targetProjectId);
      if (!project) throw new Error(`Project not found: ${targetProjectId}`);

      const model = options.model && options.model !== 'default' ? options.model : undefined;
      const config = await window.clubhouse.agent.createDurable(
        project.path,
        options.name,
        options.color,
        model,
        options.useWorktree ?? false,
        options.orchestrator,
        options.access ?? options.freeAgentMode,
        options.mcpIds,
      );
      const agentId = await useAgentStore.getState().spawnDurableAgent(
        targetProjectId, project.path, config, false,
      );
      window.clubhouse.window.requestDurableReload(targetProjectId);
      return agentId;
    },
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
  const [minimapAutoHide, setMinimapAutoHide] = useState(true);
  // Popout uses live MCP bindings as wire definitions — persistence is handled
  // by the main window's canvas store via the wireDefinitions system.
  const popoutWireDefinitions = useMcpBindingStore((s) => s.bindings);
  const [zoneWireDefinitions, setZoneWireDefinitions] = useState<ZoneWireDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guard against mutations firing before the initial IPC snapshot resolves.
  const initializedRef = useRef(false);
  const [navigation, setNavigation] = useState<CanvasPopoutReveal | null>(null);
  const [revealedViewport, setRevealedViewport] = useState<Viewport | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const navigationRef = useRef<CanvasPopoutReveal | null>(null);
  const snapshotGeneration = useRef(0);
  const pendingEdits = useRef(false);
  const viewsRef = useRef(views);
  viewsRef.current = views;
  const [navigationBaseline, setNavigationBaseline] = useState<{ views: CanvasView[]; zoneWireDefinitions: ZoneWireDefinition[] }>();

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
    const generation = snapshotGeneration.current;

    (async () => {
      await loadProjects();

      if (projectId) {
        const project = useProjectStore.getState().projects.find((p) => p.id === projectId);
        if (project) {
          await loadDurableAgents(projectId, project.path);
        }
      }

      const snapshot = await window.clubhouse.window.getCanvasState(canvasId, scope, projectId);
      if (cancelled || generation !== snapshotGeneration.current) return;

      if (snapshot) {
        setViews(snapshot.views as CanvasView[]);
        setViewport(clampViewport(snapshot.viewport));
        setZoomedViewId(snapshot.zoomedViewId);
        setZoneWireDefinitions((snapshot.zoneWireDefinitions as ZoneWireDefinition[] | undefined) ?? []);
      } else {
        setError(`Canvas "${canvasId}" not found`);
      }
      initializedRef.current = true;
      setLoading(false);
    })().catch((err) => {
      if (!cancelled) {
        if (generation !== snapshotGeneration.current) return;
        setError(`Failed to load canvas: ${err}`);
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [canvasId, projectId, scope, loadProjects, loadDurableAgents]);

  useEffect(() => {
    const offReveal = window.clubhouse.window.onCanvasPopoutReveal((request) => {
      const refuse = (message: string) => window.clubhouse.window.canvasPopoutRevealed({ requestId: request.requestId, error: message });
      if (request.canvasId !== canvasId || request.projectId !== projectId || request.snapshot.canvasId !== canvasId) {
        refuse('The Canvas window no longer owns the requested Canvas. Retry Open.');
        return;
      }
      const incoming = request.snapshot.views as CanvasView[];
      if (pendingEdits.current && viewStructure(incoming) !== viewStructure(viewsRef.current)) {
        refuse('The Canvas is still applying your edits. Retry Open after they finish.');
        return;
      }
      const target = incoming.find((view) => view.id === request.viewId && isCanvasTargetView(view, request.targetKind, request.targetId));
      if (!target || !target.position || !target.size
        || ![target.position.x, target.position.y, target.size.width, target.size.height].every(Number.isFinite)) {
        refuse('The target node is no longer available on this Canvas. Retry Open.');
        return;
      }
      if (navigationRef.current) refusePrevious(navigationRef.current);
      snapshotGeneration.current++;
      navigationRef.current = request;
      initializedRef.current = true;
      const zones = (request.snapshot.zoneWireDefinitions as ZoneWireDefinition[] | undefined) ?? [];
      useGroupProjectStore.setState({ projects: request.groupProjects, loaded: true, loadError: null });
      setNavigationBaseline({ views: incoming, zoneWireDefinitions: zones });
      setViews(incoming);
      setViewport(clampViewport(request.snapshot.viewport));
      setZoomedViewId(null);
      setSelectedViewId(request.viewId);
      setSelectedViewIds([]);
      setZoneWireDefinitions(zones);
      setNavigation(request);
      setRevealedViewport(null);
      setError(null);
      setLoading(false);
    });
    const offCancel = window.clubhouse.window.onCanvasPopoutRevealCanceled((requestId) => {
      if (navigationRef.current?.requestId !== requestId) return;
      navigationRef.current = null;
      setNavigation(null);
    });
    function refusePrevious(request: CanvasPopoutReveal) {
      window.clubhouse.window.canvasPopoutRevealed({ requestId: request.requestId, error: 'Canvas navigation was superseded.' });
    }
    return () => {
      offReveal();
      offCancel();
      if (navigationRef.current) refusePrevious(navigationRef.current);
      navigationRef.current = null;
    };
  }, [canvasId, projectId]);

  useLayoutEffect(() => {
    if (!navigation || navigationRef.current !== navigation || !revealedViewport
      || viewport.panX !== revealedViewport.panX || viewport.panY !== revealedViewport.panY || viewport.zoom !== revealedViewport.zoom
      || selectedViewId !== navigation.viewId || !containerRef.current?.contains(document.activeElement)) return;
    navigationRef.current = null;
    setNavigation(null);
    window.clubhouse.window.canvasPopoutRevealed({ requestId: navigation.requestId, viewport: revealedViewport });
  }, [navigation, revealedViewport, viewport, selectedViewId]);

  // ── Subscribe to canvas state changes from main window ────────────

  useEffect(() => {
    if (!canvasId) return;
    const remove = window.clubhouse.window.onCanvasStateChanged((state) => {
      if (state.canvasId !== canvasId || state.projectId !== projectId) return;
      const pending = navigationRef.current;
      if (pending) {
        if (state.projectId !== projectId) return;
        const target = (state.views as CanvasView[]).find((view) => view.id === pending.viewId
          && isCanvasTargetView(view, pending.targetKind, pending.targetId));
        if (!target || viewStructure(state.views as CanvasView[]) !== viewStructure(pending.snapshot.views as CanvasView[])) {
          navigationRef.current = null;
          setNavigation(null);
          window.clubhouse.window.canvasPopoutRevealed({ requestId: pending.requestId, error: 'The Canvas changed before its target could be revealed. Retry Open.' });
        }
        return;
      }
      setViews(state.views as CanvasView[]);
      pendingEdits.current = false;
      setViewport(clampViewport(state.viewport));
      setZoomedViewId(state.zoomedViewId);
      setZoneWireDefinitions((state.zoneWireDefinitions as ZoneWireDefinition[] | undefined) ?? []);
    });
    return remove;
  }, [canvasId, projectId]);

  // ── Periodic reconciliation ───────────────────────────────────────

  useEffect(() => {
    if (!canvasId) return;
    let disposed = false;
    const interval = setInterval(() => {
      const generation = snapshotGeneration.current;
      window.clubhouse.window.getCanvasState(canvasId, scope, projectId).then((snapshot) => {
        if (disposed || generation !== snapshotGeneration.current || navigationRef.current) return;
        if (snapshot) {
          setViews(snapshot.views as CanvasView[]);
          setViewport(clampViewport(snapshot.viewport));
          setZoomedViewId(snapshot.zoomedViewId);
          setZoneWireDefinitions((snapshot.zoneWireDefinitions as ZoneWireDefinition[] | undefined) ?? []);
        }
      }).catch(() => { /* silent — main window may be busy */ });
    }, RECONCILE_INTERVAL_MS);
    return () => { disposed = true; clearInterval(interval); };
  }, [canvasId, scope, projectId]);

  // ── Mutation forwarding via IPC ───────────────────────────────────

  const sendMutation = useCallback((mutation: CanvasMutation) => {
    if (!canvasId || !initializedRef.current) return;
    if (!['focusView', 'setViewport', 'zoomView', 'selectView'].includes(mutation.type)) {
      pendingEdits.current = true;
      setNavigationBaseline(undefined);
      if (navigationRef.current) {
        window.clubhouse.window.canvasPopoutRevealed({ requestId: navigationRef.current.requestId, error: 'Canvas navigation was canceled by your edit. Retry Open.' });
        navigationRef.current = null;
        setNavigation(null);
      }
    }
    window.clubhouse.window.sendCanvasMutation(canvasId, scope, mutation, projectId);
  }, [canvasId, scope, projectId]);

  const handleViewportChange = useCallback((vp: Viewport) => {
    // Apply locally for responsiveness, then forward
    setViewport(vp);
    sendMutation({ type: 'setViewport', viewport: vp });
  }, [sendMutation]);
  const handleRevealViewport = useCallback((vp: Viewport) => {
    setViewport((previous) => previous.panX === vp.panX && previous.panY === vp.panY && previous.zoom === vp.zoom ? previous : vp);
  }, []);

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
    setViews((prev) => prev.filter((v) => v.id !== viewId));
    sendMutation({ type: 'removeView', viewId });
  }, [sendMutation]);

  // Optimistically update the local views state so drag/resize/zoom/pick
  // don't visually snap back during the IPC roundtrip to the leader window.
  // The leader's broadcast still arrives and overwrites with the authoritative
  // state, but by then our local guess matches.
  const handleMoveView = useCallback((viewId: string, position: Position) => {
    setViews((prev) => prev.map((v) => (v.id === viewId ? { ...v, position } : v)));
    sendMutation({ type: 'moveView', viewId, position });
  }, [sendMutation]);

  const handleResizeView = useCallback((viewId: string, size: Size) => {
    setViews((prev) => prev.map((v) => (v.id === viewId ? { ...v, size } : v)));
    sendMutation({ type: 'resizeView', viewId, size });
  }, [sendMutation]);

  const handleFocusView = useCallback((viewId: string) => {
    sendMutation({ type: 'focusView', viewId });
  }, [sendMutation]);

  const handleUpdateView = useCallback((viewId: string, updates: Partial<CanvasView>) => {
    setViews((prev) => prev.map((v) => (v.id === viewId ? { ...v, ...updates } as CanvasView : v)));
    sendMutation({ type: 'updateView', viewId, updates: updates as Record<string, unknown> });
  }, [sendMutation]);

  const handleZoomView = useCallback((viewId: string | null) => {
    setZoomedViewId(viewId);
    sendMutation({ type: 'zoomView', viewId });
  }, [sendMutation]);

  const handleMoveViews = useCallback((positions: Map<string, Position>) => {
    setViews((prev) => prev.map((v) => {
      const pos = positions.get(v.id);
      return pos ? { ...v, position: pos } : v;
    }));
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
    <div ref={containerRef} className="w-full h-full overflow-hidden" data-testid="popout-canvas-view">
      <CanvasWorkspace
        views={views}
        viewport={viewport}
        zoomedViewId={zoomedViewId}
        selectedViewId={selectedViewId}
        selectedViewIds={selectedViewIds}
        wireDefinitions={popoutWireDefinitions}
        onAddWireDefinition={() => {}}
        onRemoveWireDefinition={() => {}}
        onUpdateWireDefinition={() => {}}
        zoneWireDefinitions={zoneWireDefinitions}
        onAddZoneWireDefinition={(wire) => ({ ...wire, id: '' })}
        onRemoveZoneWireDefinition={() => {}}
        api={api}
        navigationBaseline={navigationBaseline}
        navigationFocus={navigation ? {
          viewId: navigation.viewId,
          onRevealed: (centered) => {
            if (navigationRef.current !== navigation) return;
            setRevealedViewport((previous) => previous?.panX === centered.panX && previous.panY === centered.panY
              && previous.zoom === centered.zoom ? previous : centered);
          },
        } : undefined}
        onViewportChange={navigation ? handleRevealViewport : handleViewportChange}
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
        minimapAutoHide={minimapAutoHide}
        onMinimapAutoHideChange={setMinimapAutoHide}
        elkAlgorithm="layered"
        elkDirection="RIGHT"
        onElkAlgorithmChange={() => {}}
        onElkDirectionChange={() => {}}
        layoutCenterId={null}
        onSetLayoutCenterId={() => {}}
      />
    </div>
  );
}
