import { unstable_batchedUpdates } from 'react-dom';
import type { CanvasNavigationSnapshot, CanvasTargetIndex, CanvasTargetStore, GroupProjectNavigationIndex } from '../../../../shared/canvas-index-types';
import { findTargetCanvasHits, isCanvasTargetView, type NavigableCanvasTargetKind, type TargetCanvasHit } from '../../../../shared/canvas-persistence';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasState } from '../../../plugins/builtin/canvas/canvas-store';
import type { PopoutEntry } from '../../../../shared/plugin-types';
import { completeCanvasNavigationReveal, consumeCanvasNavigationHandoff, prepareCanvasNavigation, type CanvasNavigationHandoff } from '../../../plugins/builtin/canvas/canvas-navigation-handoff';
import { useAgentStore } from '../../../stores/agentStore';
import { durableAgentFromConfig } from '../../../stores/agent/agentCrudSlice';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
import { useMcpBindingStore } from '../../../stores/mcpBindingStore';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { usePluginStore } from '../../../plugins/plugin-store';
import { isDispatcherAgent } from '../../dispatcher/dispatcherStore';
import { openAgent } from './orchestration-hooks';

export interface ConnectionCanvasHit extends TargetCanvasHit {
  scope: CanvasTargetStore['scope'];
  projectId?: string;
  projectName?: string;
}

let latestRequest: AbortController | null = null;

export function beginConnectionNavigationRequest(): AbortController {
  latestRequest?.abort();
  latestRequest = new AbortController();
  return latestRequest;
}

function assertCurrent(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function localCanvasLoaded(state: CanvasState): boolean {
  return state.loaded && state.dataOrigin === 'local';
}

/** Loaded stores replace disk hits AND disk failures, including unsaved deletions. */
export function mergeTargetCanvasHits(kind: NavigableCanvasTargetKind, targetId: string, index: CanvasTargetIndex): {
  hits: ConnectionCanvasHit[]; errors: string[];
} {
  const errors = index.error ? [index.error] : [];
  const hits = index.stores.flatMap((entry) => {
    const store = entry.scope === 'app' ? useAppCanvasStore : getProjectCanvasStore(entry.projectId ?? null);
    const state = store.getState();
    const local = localCanvasLoaded(state);
    const found = local ? findTargetCanvasHits(state.canvases, kind, targetId) : entry.hits;
    if (!local && entry.error) errors.push(`${entry.projectName || 'Home'}: ${entry.error}`);
    return found.map((hit) => ({
      ...hit, scope: entry.scope,
      ...(entry.projectId && { projectId: entry.projectId }),
      ...(entry.projectName && { projectName: entry.projectName }),
    }));
  });
  return { hits, errors };
}

export async function lookupConnectionCanvases(kind: NavigableCanvasTargetKind, targetId: string, signal: AbortSignal) {
  const index = await window.clubhouse.canvas.getTargetCanvases(kind, targetId);
  assertCurrent(signal);
  const merged = mergeTargetCanvasHits(kind, targetId, index);
  if (merged.errors.length) throw new Error(`Canvas lookup is incomplete. ${merged.errors.join(' ')} Retry Open after the affected stores are available.`);
  return { ...merged, index };
}

export async function openConnectionAgent(agentId: string, signal: AbortSignal): Promise<void> {
  const rail = useAgentStore.getState().agents[agentId];
  if (rail && isDispatcherAgent(rail)) {
    assertCurrent(signal);
    openAgent(rail.projectId, agentId);
    return;
  }
  const target = await window.clubhouse.canvas.resolveAgentTarget(agentId);
  assertCurrent(signal);
  if ('error' in target) throw new Error(target.error);
  const registered = useProjectStore.getState().projects.find((project) => project.id === target.project.id && project.path === target.project.path);
  if (!registered) throw new Error('The target project is no longer available in this window. Reload projects and retry Open.');
  const current = useAgentStore.getState().agents[agentId];
  if (!target.config && (!current || current.projectId !== registered.id)) {
    throw new Error('This agent session is no longer available. Restore the original agent, then retry Open.');
  }
  if (target.config && (!current || current.projectId !== registered.id)) {
    const config = target.config;
    useAgentStore.setState((state) => ({ agents: { ...state.agents, [agentId]: durableAgentFromConfig(registered.id, config) } }));
  }
  useUIStore.getState().setActiveHost(null);
  openAgent(registered.id, agentId);
}

export async function jumpToConnectionCanvas(
  kind: NavigableCanvasTargetKind, targetId: string, hit: ConnectionCanvasHit, signal: AbortSignal,
  freshIndex?: GroupProjectNavigationIndex,
): Promise<void> {
  const { index, hits, errors } = freshIndex
    ? { index: freshIndex, ...mergeTargetCanvasHits(kind, targetId, freshIndex) }
    : await lookupConnectionCanvases(kind, targetId, signal);
  assertCurrent(signal);
  if (errors.length) throw new Error(`Canvas lookup is incomplete. ${errors.join(' ')} Retry Open after the affected stores are available.`);
  if (!hits.some((entry) => entry.scope === hit.scope && entry.projectId === hit.projectId
    && entry.canvasId === hit.canvasId && entry.viewId === hit.viewId)) {
    throw new Error('This Canvas representation was removed. Retry Open to find its current representations.');
  }
  const project = hit.scope === 'project'
    ? useProjectStore.getState().projects.find((entry) => entry.id === hit.projectId)
    : undefined;
  if (hit.scope === 'project' && !project) throw new Error('This Canvas project was removed. Restore the project and retry Open.');
  const store = hit.scope === 'app' ? useAppCanvasStore : getProjectCanvasStore(hit.projectId ?? null);
  let groupProjects = index.groupProjects;
  let pendingSnapshot: CanvasNavigationSnapshot | undefined;
  if (!localCanvasLoaded(store.getState())) {
    const snapshot = await window.clubhouse.canvas.readForNavigation(kind, targetId, hit.projectId);
    assertCurrent(signal);
    if (project && !useProjectStore.getState().projects.some((entry) => entry.id === project.id && entry.path === project.path)) {
      throw new Error('This Canvas project was removed while loading. Restore it and retry Open.');
    }
    // A concurrent load or unsaved edit wins over a disk read that started earlier.
    if (!localCanvasLoaded(store.getState())) pendingSnapshot = snapshot;
    groupProjects = snapshot.groupProjects;
  }
  assertCurrent(signal);
  const popouts: PopoutEntry[] = await window.clubhouse.window.listPopouts();
  assertCurrent(signal);
  const destinations = popouts.filter((entry) => entry.params.type === 'canvas'
    && entry.params.canvasId === hit.canvasId && entry.params.projectId === hit.projectId);
  if (destinations.length > 1) throw new Error('More than one window claims this Canvas. Close the duplicate explicitly and retry Open.');
  const destination = destinations[0];
  let prepared: CanvasNavigationHandoff | undefined;
  let revealRequestId: string | undefined;
  let departed = false;
  const tab = hit.scope === 'app' ? 'plugin:app:canvas' : 'plugin:canvas';
  const route = (handoff: CanvasNavigationHandoff) => {
    const ui = useUIStore.getState();
    ui.setActiveHost(null);
    ui.setDispatcherOpen(false);
    useProjectStore.getState().setActiveProject(hit.projectId ?? null);
    ui.setExplorerTab(tab, hit.projectId);
    const cancelIfDeparted = () => {
      if (useUIStore.getState().explorerTab !== tab
        || useUIStore.getState().activeHostId !== null
        || useProjectStore.getState().activeProjectId !== (hit.projectId ?? null)
        || (hit.projectId && !useProjectStore.getState().projects.some((entry) => entry.id === hit.projectId))) {
        consumeCanvasNavigationHandoff(store, handoff);
      }
    };
    const offUI = useUIStore.subscribe(cancelIfDeparted);
    const offProject = useProjectStore.subscribe(cancelIfDeparted);
    handoff.dispose = () => { offUI(); offProject(); };
    cancelIfDeparted();
  };
  unstable_batchedUpdates(() => {
    if (pendingSnapshot && !localCanvasLoaded(store.getState())) store.getState().hydrateForNavigation(pendingSnapshot, hit.canvasId);
    const canvas = store.getState().canvases.find((entry) => entry.id === hit.canvasId);
    const view = canvas?.views.find((entry) => entry.id === hit.viewId && isCanvasTargetView(entry, kind, targetId));
    if (!view) throw new Error('The Canvas or its target node was deleted while loading. Retry Open to refresh its representations.');
    if (!view.position || !view.size || ![view.position.x, view.position.y, view.size.width, view.size.height].every(Number.isFinite)) {
      throw new Error('The target node has unreadable layout data. Repair the saved Canvas and retry Open.');
    }
    const handoff = prepareCanvasNavigation(store, { ...hit, kind, targetId }, useMcpBindingStore.getState().bindings);
    handoff.popoutWindowId = destination?.windowId;
    prepared = handoff;
    if (groupProjects) useGroupProjectStore.setState({ projects: groupProjects, loaded: true, loadError: null });
    store.getState().setActiveCanvas(hit.canvasId);
    store.getState().zoomView(null);
    store.getState().focusView(hit.viewId);
    store.getState().selectView(hit.viewId);
    handoff.state = store.getState();
    if (!destination) route(handoff);
  });
  if (destination && prepared) {
    const handoff = prepared;
    const canvas = store.getState().canvases.find((entry) => entry.id === hit.canvasId);
    if (!canvas) throw new Error('The owning Canvas was removed before its window could open. Retry Open.');
    revealRequestId = crypto.randomUUID();
    const requestId = revealRequestId;
    const cancel = () => {
      window.clubhouse.window.cancelCanvasPopoutReveal(requestId);
      consumeCanvasNavigationHandoff(store, handoff);
    };
    const callerUI = useUIStore.getState();
    const callerProject = useProjectStore.getState().activeProjectId;
    const callerAgent = useAgentStore.getState().activeAgentId;
    const cancelIfDeparted = () => {
      const ui = useUIStore.getState();
      if (ui.explorerTab !== callerUI.explorerTab || ui.activeHostId !== callerUI.activeHostId
        || ui.dispatcherOpen !== callerUI.dispatcherOpen
        || useProjectStore.getState().activeProjectId !== callerProject
        || useAgentStore.getState().activeAgentId !== callerAgent
        || store.getState().activeCanvasId !== hit.canvasId
        || (project && !useProjectStore.getState().projects.some((entry) => entry.id === project.id && entry.path === project.path))) {
        departed = true;
        cancel();
      }
    };
    // The initiating Card stays mounted until ACK; genuine caller departure still cancels.
    const offUI = useUIStore.subscribe(cancelIfDeparted);
    const offProject = useProjectStore.subscribe(cancelIfDeparted);
    const offAgent = useAgentStore.subscribe(cancelIfDeparted);
    const offCanvas = store.subscribe(cancelIfDeparted);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      assertCurrent(signal);
      const result = await window.clubhouse.window.revealCanvasPopout({
        requestId, windowId: destination.windowId, canvasId: hit.canvasId, projectId: hit.projectId,
        viewId: hit.viewId, targetKind: kind, targetId,
        snapshot: {
          canvasId: canvas.id, name: canvas.name, views: canvas.views, viewport: canvas.viewport,
          nextZIndex: canvas.nextZIndex, zoomedViewId: canvas.zoomedViewId,
          selectedViewId: canvas.selectedViewId, projectId: hit.projectId, scope: hit.scope === 'app' ? 'global' : 'project-local',
          zoneWireDefinitions: store.getState().zoneWireDefinitions,
        },
        groupProjects: groupProjects ?? [],
      });
      assertCurrent(signal);
      if (departed || result.requestId !== requestId) throw new Error('Canvas navigation changed before its target was revealed. Retry Open.');
      if ('error' in result) throw new Error(result.error);
      if (store.getState().activeCanvasId !== hit.canvasId) throw new Error('The active Canvas changed before the target was revealed. Retry Open.');
      offUI(); offProject(); offAgent(); offCanvas();
      unstable_batchedUpdates(() => {
        store.getState().setViewport(result.viewport);
        completeCanvasNavigationReveal(store, handoff);
        route(handoff);
      });
    } catch (error) {
      cancel();
      throw error;
    } finally {
      offUI(); offProject(); offAgent(); offCanvas();
      signal.removeEventListener('abort', cancel);
    }
  }
}

/** Plugin IDs have a genuine tab only when that enabled plugin contributes one. */
export function pluginNavigationReason(pluginId: string, projectId: string, plugins = usePluginStore.getState()): string | null {
  const entry = plugins.plugins[pluginId];
  if (!entry?.manifest.contributes?.tab) return 'This plugin has no standalone navigation view.';
  if (entry.status !== 'activated') return 'This plugin is unavailable. Enable it in Settings before opening its view.';
  const projectEnabled = entry.manifest.scope !== 'app' && (plugins.projectEnabled[projectId] ?? []).includes(pluginId);
  const appEnabled = entry.manifest.scope !== 'project' && plugins.appEnabled.includes(pluginId);
  return projectEnabled || appEnabled ? null : 'This plugin is not enabled in the connection project. Enable it in Settings before opening its view.';
}

export function openConnectionPlugin(pluginId: string, projectId: string): void {
  const reason = pluginNavigationReason(pluginId, projectId);
  if (reason) throw new Error(reason);
  const plugins = usePluginStore.getState();
  const app = plugins.plugins[pluginId].manifest.scope === 'app' || !(plugins.projectEnabled[projectId] ?? []).includes(pluginId);
  if (!app && !useProjectStore.getState().projects.some((project) => project.id === projectId)) {
    throw new Error('The connection project was removed. Restore it and retry Open.');
  }
  const ui = useUIStore.getState();
  ui.setActiveHost(null);
  ui.setDispatcherOpen(false);
  useProjectStore.getState().setActiveProject(app ? null : projectId);
  ui.setExplorerTab(app ? `plugin:app:${pluginId}` : `plugin:${pluginId}`, app ? undefined : projectId);
}
