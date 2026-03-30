import React, { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import type { PluginContext, PluginAPI, PluginModule, PluginAgentDetailedStatus, CompletedQuickAgentInfo } from '../../../../shared/plugin-types';
import { createHubStore } from './useHubStore';
import { collectLeaves } from './pane-tree';
import { PaneContainer } from './PaneContainer';
import type { PaneComponentProps } from './PaneContainer';
import { HubPane } from './HubPane';
import { HubTabBar } from './HubTabBar';
import { AgentPicker } from './AgentPicker';
import { CrossProjectAgentPicker } from './CrossProjectAgentPicker';
import { broadcastHubState } from './hub-sync';
import { PoppedOutPlaceholder } from '../../../features/popout/PoppedOutPlaceholder';
import { usePopouts } from '../../../hooks/usePopouts';
import { isRemoteAgentId } from '../../../stores/remoteProjectStore';
import { useUIStore } from '../../../stores/uiStore';
import { usePluginStore } from '../../plugin-store';
import { UpgradeToCanvasDialog } from './UpgradeToCanvasDialog';
import { CanvasUpgradeBanner } from './CanvasUpgradeBanner';
import { MigrateAllHubsModal } from './MigrateAllHubsModal';
import { convertHubToCanvas, convertAllHubsToCanvases } from './hub-to-canvas';
import type { ScopedHubs } from './hub-to-canvas';
import { useAppCanvasStore, getProjectCanvasStore } from '../canvas/main';
import { createScopedStorage } from '../../plugin-api-storage';

const PANE_PREFIX = 'hub';

// App-mode hub store: single instance shared across all projects
export const useAppHubStore = createHubStore(PANE_PREFIX);

// Project-mode hub stores: one per project, keyed by projectId
const projectHubStores = new Map<string, ReturnType<typeof createHubStore>>();

/** Check whether a hub store already exists for the given project (without creating one). */
export function hasProjectHubStore(projectId: string | null): boolean {
  return projectId !== null && projectHubStores.has(projectId);
}

/** Get (or create) the hub store for a specific project. */
export function getProjectHubStore(projectId: string | null): ReturnType<typeof createHubStore> {
  if (!projectId) return createHubStore(PANE_PREFIX); // transient fallback
  let store = projectHubStores.get(projectId);
  if (!store) {
    store = createHubStore(PANE_PREFIX);
    projectHubStores.set(projectId, store);
  }
  return store;
}

export function activate(ctx: PluginContext, api: PluginAPI): void {
  const disposable = api.commands.register('split-pane', () => {
    const store = api.context.mode === 'app' ? useAppHubStore : getProjectHubStore(api.context.projectId ?? null);
    const { focusedPaneId } = store.getState();
    store.getState().splitPane(focusedPaneId, 'horizontal', PANE_PREFIX);
  });
  ctx.subscriptions.push(disposable);
}

export function deactivate(): void {
  // subscriptions auto-disposed
}

export function MainPanel({ api }: { api: PluginAPI }) {
  const isAppMode = api.context.mode === 'app';
  const store = isAppMode ? useAppHubStore : getProjectHubStore(api.context.projectId ?? null);
  const storage = isAppMode ? api.storage.global : api.storage.projectLocal;

  const hubs = store((s) => s.hubs);
  const activeHubId = store((s) => s.activeHubId);
  const paneTree = store((s) => s.paneTree);
  const focusedPaneId = store((s) => s.focusedPaneId);
  const loaded = store((s) => s.loaded);

  // Check if canvas plugin is enabled (gate "Upgrade to Canvas" action)
  const canvasEnabled = usePluginStore((s) => s.appEnabled.includes('canvas'));

  // Dynamic title: show active hub name
  const activeHub = hubs.find((h) => h.id === activeHubId);
  useEffect(() => {
    if (activeHub?.name) {
      api.window.setTitle(activeHub.name);
    } else {
      api.window.resetTitle();
    }
  }, [api, activeHub?.name]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load persisted state
  const currentProjectId = isAppMode ? undefined : api.context.projectId;
  useEffect(() => {
    store.getState().loadHub(storage, PANE_PREFIX, currentProjectId);
  }, [store, storage, currentProjectId]);

  // Debounced auto-save
  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      store.getState().saveHub(storage);
    }, 500);
  }, [store, storage]);

  useEffect(() => {
    if (!loaded) return;
    scheduleSave();
  }, [hubs, paneTree, loaded, scheduleSave]);

  // Broadcast hub state changes to pop-out windows (immediate, not debounced)
  const isPopout = window.clubhouse.window.isPopout();
  useEffect(() => {
    if (!loaded || isPopout) return;
    broadcastHubState(store, activeHubId);
  }, [hubs, paneTree, loaded, store, activeHubId, isPopout]);

  // Force re-render when agents change so the list stays fresh
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    const sub = api.agents.onAnyChange(() => {
      setAgentTick((n) => n + 1);
    });
    return () => sub.dispose();
  }, [api]);

  // Agents — recomputed on each tick
  const agents = useMemo(() => api.agents.list(), [api, agentTick]);
  const agentIds = useMemo(() => new Set(agents.map((a) => a.id)), [agents]);

  useEffect(() => {
    if (!loaded) return;
    // Protect remote agent IDs already assigned to panes: remote agents
    // arrive asynchronously via satellite snapshots and may not be in
    // agentIds yet.  Without this guard the first validateAgents call
    // would clear them before the snapshot populates the list.
    const knownIds = new Set(agentIds);
    for (const hub of store.getState().hubs) {
      for (const leaf of collectLeaves(hub.paneTree)) {
        if (leaf.agentId && isRemoteAgentId(leaf.agentId)) {
          knownIds.add(leaf.agentId);
        }
      }
    }
    store.getState().validateAgents(knownIds);
  }, [loaded, agentIds, store]);

  const detailedStatuses = useMemo(() => {
    const map: Record<string, PluginAgentDetailedStatus | null> = {};
    for (const a of agents) {
      map[a.id] = api.agents.getDetailedStatus(a.id);
    }
    return map;
  }, [agents, api, agentTick]);

  const completedAgents = useMemo(() => {
    if (isAppMode) {
      const projects = api.projects.list();
      const all: CompletedQuickAgentInfo[] = [];
      for (const p of projects) {
        all.push(...api.agents.listCompleted(p.id));
      }
      return all;
    }
    return api.agents.listCompleted();
  }, [api, isAppMode, agentTick]);

  const handleSplit = useCallback((paneId: string, dir: 'horizontal' | 'vertical', pos: 'before' | 'after' = 'after') => {
    store.getState().splitPane(paneId, dir, PANE_PREFIX, pos);
  }, [store]);

  const handleClose = useCallback((paneId: string) => {
    store.getState().closePane(paneId, PANE_PREFIX);
  }, [store]);

  const handleSwap = useCallback((id1: string, id2: string) => {
    store.getState().swapPanes(id1, id2);
  }, [store]);

  const handleAssign = useCallback((paneId: string, agentId: string | null, projectId?: string) => {
    store.getState().assignAgent(paneId, agentId, projectId);
  }, [store]);

  const handleFocus = useCallback((paneId: string) => {
    store.getState().setFocusedPane(paneId);
  }, [store]);

  const zoomedPaneId = store((s) => s.zoomedPaneId);
  const { findHubPopout, findAgentPopout } = usePopouts();

  const handleSplitResize = useCallback((splitId: string, ratio: number) => {
    store.getState().setSplitRatio(splitId, ratio);
  }, [store]);

  const handleZoom = useCallback((paneId: string) => {
    store.getState().toggleZoom(paneId);
  }, [store]);

  // ── Hub tab bar callbacks ──────────────────────────────────────────

  const handleSelectHub = useCallback((hubId: string) => {
    store.getState().setActiveHub(hubId);
  }, [store]);

  const handleAddHub = useCallback(() => {
    store.getState().addHub(PANE_PREFIX);
  }, [store]);

  const handleRemoveHub = useCallback((hubId: string) => {
    store.getState().removeHub(hubId, PANE_PREFIX);
  }, [store]);

  const handleRenameHub = useCallback((hubId: string, name: string) => {
    store.getState().renameHub(hubId, name);
  }, [store]);

  const handlePopOutHub = useCallback(async (hubId: string, hubName: string) => {
    await window.clubhouse.window.createPopout({
      type: 'hub',
      hubId,
      projectId: isAppMode ? undefined : api.context.projectId,
      title: `Hub — ${hubName}`,
    });
  }, [isAppMode, api]);

  // ── Upgrade to canvas ─────────────────────────────────────────────

  const [upgradeHubId, setUpgradeHubId] = useState<string | null>(null);
  const upgradeHub = upgradeHubId ? hubs.find((h) => h.id === upgradeHubId) : null;

  const canvasStore = isAppMode ? useAppCanvasStore : getProjectCanvasStore(api.context.projectId ?? null);
  // Build a canvas-scoped storage handle so we can persist across plugin boundaries
  const canvasStorage = useMemo(() =>
    isAppMode
      ? createScopedStorage('canvas', 'global')
      : createScopedStorage('canvas', 'project-local', api.context.projectPath),
    [isAppMode, api.context.projectPath],
  );

  const performUpgrade = useCallback(async (deleteOriginal: boolean) => {
    if (!upgradeHub) return;

    const canvasInstance = convertHubToCanvas({
      hubName: upgradeHub.name,
      paneTree: upgradeHub.paneTree,
      referenceWidth: window.innerWidth,
      referenceHeight: window.innerHeight,
      deleteOriginal,
      containerWidth: window.innerWidth,
      containerHeight: window.innerHeight,
    });

    await canvasStore.getState().loadAndInsertCanvas(canvasInstance, canvasStorage);

    if (deleteOriginal) {
      store.getState().removeHub(upgradeHub.id, PANE_PREFIX);
    }

    setUpgradeHubId(null);
  }, [upgradeHub, canvasStore, canvasStorage, store]);

  const handleUpgradeToCanvas = useCallback((hubId: string) => {
    setUpgradeHubId(hubId);
  }, []);

  const handleDuplicateHub = useCallback((hubId: string) => {
    store.getState().duplicateHub(hubId, PANE_PREFIX);
  }, [store]);

  // ── Canvas upgrade banner + bulk migration ────────────────────────

  const BANNER_DISMISSED_KEY = 'canvas-upgrade-banner-dismissed';
  const globalStorage = api.storage.global;

  const [bannerDismissed, setBannerDismissed] = useState(true); // hidden until loaded
  const [showMigrateModal, setShowMigrateModal] = useState(false);

  // Load dismissed state on mount
  useEffect(() => {
    globalStorage.read(BANNER_DISMISSED_KEY).then((val) => {
      setBannerDismissed(val === true);
    }).catch(() => {
      setBannerDismissed(false);
    });
  }, [globalStorage]);

  const showBanner = canvasEnabled && !bannerDismissed;

  const handleDismissBanner = useCallback(async () => {
    setBannerDismissed(true);
    await globalStorage.write(BANNER_DISMISSED_KEY, true);
  }, [globalStorage]);

  // Collect all hubs across app + open projects for migration count
  const allHubCount = useMemo(() => {
    let count = useAppHubStore.getState().hubs.length;
    for (const [, projectStore] of projectHubStores) {
      count += projectStore.getState().hubs.length;
    }
    return count;
  }, [hubs]); // re-derive when current store's hubs change

  const handleMigrateAll = useCallback(async () => {
    setShowMigrateModal(false);

    // Gather all hubs
    const appHubs = useAppHubStore.getState().hubs;
    const projectMap = new Map<string, ReturnType<typeof useAppHubStore.getState>['hubs']>();
    for (const [projectId, projectStore] of projectHubStores) {
      const loaded = projectStore.getState().loaded;
      if (loaded) {
        projectMap.set(projectId, projectStore.getState().hubs);
      }
    }

    const scopedHubs: ScopedHubs = { app: appHubs, projects: projectMap };
    const result = convertAllHubsToCanvases(scopedHubs, window.innerWidth, window.innerHeight);

    // Insert app-level canvases
    const appCanvasStore = useAppCanvasStore;
    const appCanvasStorage = createScopedStorage('canvas', 'global');
    for (const canvas of result.app) {
      await appCanvasStore.getState().loadAndInsertCanvas(canvas, appCanvasStorage);
    }

    // Insert per-project canvases
    for (const [projectId, canvases] of result.projects) {
      const projCanvasStore = getProjectCanvasStore(projectId);
      // We need the project path to build storage — look it up from the project store's context
      const projects = api.projects.list();
      const proj = projects.find((p) => p.id === projectId);
      if (!proj) continue;
      const projCanvasStorage = createScopedStorage('canvas', 'project-local', proj.path);
      for (const canvas of canvases) {
        await projCanvasStore.getState().loadAndInsertCanvas(canvas, projCanvasStorage);
      }
    }

    // Disable hub plugin and persist
    usePluginStore.getState().disableApp('hub');
    try {
      await window.clubhouse.plugin.storageWrite({
        pluginId: '_system',
        scope: 'global',
        key: 'app-enabled',
        value: usePluginStore.getState().appEnabled,
      });
    } catch { /* best effort */ }

    // Dismiss the banner permanently
    await handleDismissBanner();

    // Navigate to the canvas that corresponds to the hub the user was viewing
    const CANVAS_TAB = 'plugin:canvas';
    const activeHubName = activeHub?.name;
    if (isAppMode) {
      if (activeHubName) {
        const matchingCanvas = result.app.find((c) => c.name === activeHubName);
        if (matchingCanvas) {
          useAppCanvasStore.getState().setActiveCanvas(matchingCanvas.id);
        }
      }
      useUIStore.getState().setExplorerTab(CANVAS_TAB);
    } else if (currentProjectId) {
      if (activeHubName) {
        const projectCanvases = result.projects.get(currentProjectId);
        const matchingCanvas = projectCanvases?.find((c) => c.name === activeHubName);
        if (matchingCanvas) {
          getProjectCanvasStore(currentProjectId).getState().setActiveCanvas(matchingCanvas.id);
        }
      }
      useUIStore.getState().setExplorerTab(CANVAS_TAB, currentProjectId);
    }
  }, [api, handleDismissBanner, activeHub, isAppMode, currentProjectId]);

  // ── Stable PaneComponent identity ──────────────────────────────────
  const dataRef = useRef({ api, agents, detailedStatuses, completedAgents, isAppMode, handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom, zoomedPaneId, findAgentPopout });
  dataRef.current = { api, agents, detailedStatuses, completedAgents, isAppMode, handleSplit, handleClose, handleSwap, handleAssign, handleFocus, handleZoom, zoomedPaneId, findAgentPopout };

  const HubPaneComponent = useCallback(({ pane, focused, canClose }: PaneComponentProps) => {
    const d = dataRef.current;
    const picker = d.isAppMode
      ? React.createElement(CrossProjectAgentPicker, {
          api: d.api,
          agents: d.agents,
          onPick: (agentId: string, projectId: string) => d.handleAssign(pane.id, agentId, projectId),
        })
      : React.createElement(AgentPicker, {
          api: d.api,
          agents: d.agents,
          onPick: (agentId: string) => d.handleAssign(pane.id, agentId),
        });

    return React.createElement(HubPane, {
      pane,
      api: d.api,
      focused,
      canClose,
      onSplit: d.handleSplit,
      onClose: d.handleClose,
      onSwap: d.handleSwap,
      onAssign: d.handleAssign,
      onFocus: d.handleFocus,
      onZoom: d.handleZoom,
      isZoomed: d.zoomedPaneId === pane.id,
      agents: d.agents,
      detailedStatuses: d.detailedStatuses,
      completedAgents: d.completedAgents,
      findAgentPopout: d.findAgentPopout,
    }, picker);
  }, []); // Empty deps — stable identity, reads latest values from ref

  if (!loaded) {
    return React.createElement('div', { className: 'flex items-center justify-center h-full text-ctp-subtext0 text-xs' }, 'Loading hub...');
  }

  const hubPopout = findHubPopout(activeHubId);

  return React.createElement('div', { className: 'flex flex-col h-full w-full' },
    React.createElement(HubTabBar, {
      hubs,
      activeHubId,
      onSelectHub: handleSelectHub,
      onAddHub: handleAddHub,
      onRemoveHub: handleRemoveHub,
      onRenameHub: handleRenameHub,
      onPopOutHub: handlePopOutHub,
      onUpgradeToCanvas: canvasEnabled ? handleUpgradeToCanvas : undefined,
      onDuplicateHub: handleDuplicateHub,
    }),
    showBanner && React.createElement(CanvasUpgradeBanner, {
      onMigrateAll: () => setShowMigrateModal(true),
      onDismiss: handleDismissBanner,
    }),
    hubPopout
      ? React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(PoppedOutPlaceholder, {
            type: 'hub',
            name: activeHub?.name,
            windowId: hubPopout.windowId,
          }),
        )
      : React.createElement('div', { className: 'flex-1 min-h-0' },
          React.createElement(PaneContainer, {
            tree: paneTree,
            focusedPaneId,
            PaneComponent: HubPaneComponent,
            zoomedPaneId,
            onSplitResize: handleSplitResize,
          }),
        ),
    upgradeHub && React.createElement(UpgradeToCanvasDialog, {
      hubName: upgradeHub.name,
      onUpgrade: () => performUpgrade(false),
      onUpgradeAndDelete: () => performUpgrade(true),
      onClose: () => setUpgradeHubId(null),
    }),
    showMigrateModal && React.createElement(MigrateAllHubsModal, {
      hubCount: allHubCount,
      onConfirm: handleMigrateAll,
      onCancel: () => setShowMigrateModal(false),
    }),
  );
}

// Compile-time type assertion
const _: PluginModule = { activate, deactivate, MainPanel };
void _;
