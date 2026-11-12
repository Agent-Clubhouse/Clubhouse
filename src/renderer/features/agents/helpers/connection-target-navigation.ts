import { unstable_batchedUpdates } from 'react-dom';
import type { CanvasTargetIndex, CanvasTargetStore, GroupProjectNavigationIndex } from '../../../../shared/canvas-index-types';
import { findTargetCanvasHits, isCanvasTargetView, type NavigableCanvasTargetKind, type TargetCanvasHit } from '../../../../shared/canvas-persistence';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasState } from '../../../plugins/builtin/canvas/canvas-store';
import { consumeCanvasNavigationHandoff, prepareCanvasNavigation } from '../../../plugins/builtin/canvas/canvas-navigation-handoff';
import { useAgentStore } from '../../../stores/agentStore';
import { durableAgentFromConfig } from '../../../stores/agent/agentCrudSlice';
import { useGroupProjectStore } from '../../../stores/groupProjectStore';
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
  if (!localCanvasLoaded(store.getState())) {
    const snapshot = await window.clubhouse.canvas.readForNavigation(kind, targetId, hit.projectId);
    assertCurrent(signal);
    if (project && !useProjectStore.getState().projects.some((entry) => entry.id === project.id && entry.path === project.path)) {
      throw new Error('This Canvas project was removed while loading. Restore it and retry Open.');
    }
    // A concurrent load or unsaved edit wins over a disk read that started earlier.
    if (!localCanvasLoaded(store.getState())) store.getState().hydrateForNavigation(snapshot, hit.canvasId);
    groupProjects = snapshot.groupProjects;
  }
  assertCurrent(signal);
  const canvas = store.getState().canvases.find((entry) => entry.id === hit.canvasId);
  const view = canvas?.views.find((entry) => entry.id === hit.viewId && isCanvasTargetView(entry, kind, targetId));
  if (!view) throw new Error('The Canvas or its target node was deleted while loading. Retry Open to refresh its representations.');
  if (!view.position || !view.size || ![view.position.x, view.position.y, view.size.width, view.size.height].every(Number.isFinite)) {
    throw new Error('The target node has unreadable layout data. Repair the saved Canvas and retry Open.');
  }
  const handoff = prepareCanvasNavigation(store, { ...hit, kind, targetId });
  unstable_batchedUpdates(() => {
    if (groupProjects) useGroupProjectStore.setState({ projects: groupProjects, loaded: true, loadError: null });
    store.getState().setActiveCanvas(hit.canvasId);
    store.getState().zoomView(null);
    store.getState().focusView(hit.viewId);
    store.getState().selectView(hit.viewId);
    handoff.state = store.getState();
    const ui = useUIStore.getState();
    ui.setActiveHost(null);
    ui.setDispatcherOpen(false);
    useProjectStore.getState().setActiveProject(hit.projectId ?? null);
    ui.setExplorerTab('plugin:canvas', hit.projectId);
    const cancelIfDeparted = () => {
      if (useUIStore.getState().explorerTab !== 'plugin:canvas'
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
  });
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
  ui.setExplorerTab(`plugin:${pluginId}`, app ? undefined : projectId);
}
