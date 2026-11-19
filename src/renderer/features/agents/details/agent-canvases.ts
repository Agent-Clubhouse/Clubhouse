// ── Which canvases hold an agent's card ─────────────────────────────
//
// A canvas store only fills when its canvas view is opened. Until then the
// main process answers from the persisted stores (#1544), so the Canvases card
// doesn't say "not on a canvas" just because nothing was opened yet. Once a
// store has loaded it is the source of truth: it has edits not yet saved.

import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../../../shared/types';
import type { CanvasMembership } from '../../../../shared/canvas-index-types';
import { findAgentCanvasHits } from '../../../../shared/canvas-persistence';
import { useProjectStore } from '../../../stores/projectStore';
import { useUIStore } from '../../../stores/uiStore';
import { isRemoteProjectId, parseNamespacedId } from '../../../stores/remoteProjectStore';
import { useAnnexClientStore } from '../../../stores/annexClientStore';
import { getProjectCanvasStore, useAppCanvasStore } from '../../../plugins/builtin/canvas/main';
import type { CanvasInstance } from '../../../plugins/builtin/canvas/canvas-types';

const CANVAS_TAB = 'plugin:canvas';

export interface CanvasHit {
  scope: 'project' | 'app';
  canvasId: string;
  name: string;
  viewId: string;
}

function hitsIn(canvases: CanvasInstance[], agentId: string, scope: CanvasHit['scope']): CanvasHit[] {
  return findAgentCanvasHits(canvases, agentId).map((h) => ({ scope, ...h }));
}

/**
 * Project hits then Home hits. Each scope comes from its live store when that
 * store has loaded, else from the persisted index.
 */
export function mergeCanvasHits(
  live: { project: CanvasHit[] | null; app: CanvasHit[] | null },
  indexed: CanvasMembership[],
): CanvasHit[] {
  const fromIndex = (scope: CanvasHit['scope']): CanvasHit[] =>
    indexed
      .filter((m) => m.scope === scope)
      .map((m) => ({ scope, canvasId: m.canvasId, name: m.name, viewId: m.viewId }));
  return [...(live.project ?? fromIndex('project')), ...(live.app ?? fromIndex('app'))];
}

/** The canvases that hold a card for this agent, in its project and on Home. */
export function useAgentCanvases(agent: Agent): CanvasHit[] {
  const projectStore = useMemo(() => getProjectCanvasStore(agent.projectId ?? null), [agent.projectId]);
  const projectCanvases = projectStore((s) => s.canvases);
  const projectLoaded = projectStore((s) => s.loaded);
  const appCanvases = useAppCanvasStore((s) => s.canvases);
  const appLoaded = useAppCanvasStore((s) => s.loaded);

  // A remote project's canvas lives on its satellite, not on this disk.
  const localProjectId = agent.projectId && !isRemoteProjectId(agent.projectId) ? agent.projectId : null;
  const needIndex = !appLoaded || (!!localProjectId && !projectLoaded);
  const [indexed, setIndexed] = useState<CanvasMembership[]>([]);
  useEffect(() => {
    if (!needIndex) return;
    let cancelled = false;
    Promise.resolve(window.clubhouse.canvas?.getAgentCanvases?.(agent.id, localProjectId))
      .then((hits) => { if (!cancelled) setIndexed(Array.isArray(hits) ? hits : []); })
      .catch(() => { if (!cancelled) setIndexed([]); });
    return () => { cancelled = true; };
  }, [agent.id, localProjectId, needIndex]);

  return useMemo(() => mergeCanvasHits({
    project: projectLoaded || !localProjectId ? hitsIn(projectCanvases, agent.id, 'project') : null,
    app: appLoaded ? hitsIn(appCanvases, agent.id, 'app') : null,
  }, indexed), [projectCanvases, projectLoaded, appCanvases, appLoaded, localProjectId, agent.id, indexed]);
}

type CanvasStoreHook = ReturnType<typeof getProjectCanvasStore>;

let pendingJump: (() => void) | null = null;

/**
 * Focus a card once its store has loaded. Opening the canvas tab loads the
 * store from disk, which restores the saved active canvas, so selecting the
 * hit before that would be overwritten.
 */
function focusWhenLoaded(store: CanvasStoreHook, hit: CanvasHit): void {
  pendingJump?.();
  pendingJump = null;
  const apply = (): void => {
    const s = store.getState();
    s.setActiveCanvas(hit.canvasId);
    s.focusView(hit.viewId);
    s.selectView(hit.viewId);
  };
  if (store.getState().loaded) {
    apply();
    return;
  }
  const unsubscribe = store.subscribe((s) => {
    if (!s.loaded) return;
    unsubscribe();
    pendingJump = null;
    apply();
  });
  pendingJump = unsubscribe;
}

export function jumpToCanvas(agent: Agent, hit: CanvasHit): void {
  if (parseNamespacedId(agent.id)) { jumpToRemoteCanvas(agent, hit); return; }
  const ui = useUIStore.getState();
  if (hit.scope === 'project' && agent.projectId) {
    useProjectStore.getState().setActiveProject(agent.projectId);
    ui.setExplorerTab(CANVAS_TAB, agent.projectId);
    focusWhenLoaded(getProjectCanvasStore(agent.projectId), hit);
  } else {
    useProjectStore.getState().setActiveProject(null);
    ui.setExplorerTab(CANVAS_TAB);
    focusWhenLoaded(useAppCanvasStore, hit);
  }
}

/** A membership is useful even when a bounded/old snapshot cannot supply its board for navigation. */
export function remoteCanvasJumpUnavailable(agent: Agent, hit: CanvasHit): string | null {
  const address = parseNamespacedId(agent.id);
  const project = agent.projectId ? parseNamespacedId(agent.projectId) : null;
  if (!address || project?.satelliteId !== address.satelliteId) return 'The host project identity is unavailable.';
  const host = useAnnexClientStore.getState().satellites.find((s) => s.id === address.satelliteId);
  if (host?.state !== 'connected' || host.snapshotUnavailable) return 'Reconnect to the host to open this board.';
  // Check the CURRENT snapshot, not remoteProjectStore's retained omitted canvas state.
  const state = hit.scope === 'app' ? host.snapshot?.appCanvasState : host.snapshot?.canvasState?.[project.agentId];
  if (!state || !containsCanvasHit(state.canvases, address.agentId, hit)) {
    return 'This board is not in the host’s current shared snapshot. Open it on the host.';
  }
  return null;
}

function containsCanvasHit(canvases: unknown[], agentId: string, hit: CanvasHit): boolean {
  return canvases.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const c = entry as { id?: unknown; views?: unknown };
    return c.id === hit.canvasId && Array.isArray(c.views) && c.views.some((view: unknown) => !!view && typeof view === 'object'
      && (view as { id?: unknown }).id === hit.viewId && (view as { type?: unknown }).type === 'agent' && (view as { agentId?: unknown }).agentId === agentId);
  });
}

function jumpToRemoteCanvas(agent: Agent, hit: CanvasHit): void {
  if (remoteCanvasJumpUnavailable(agent, hit)) return;
  const address = parseNamespacedId(agent.id)!;
  const ui = useUIStore.getState();
  pendingJump?.();
  pendingJump = null;
  ui.setActiveHost(address.satelliteId);
  const projectId = hit.scope === 'project' ? agent.projectId! : null;
  useProjectStore.getState().setActiveProject(projectId);
  ui.setExplorerTab(CANVAS_TAB, projectId ?? undefined);
  const store = projectId ? getProjectCanvasStore(projectId) : useAppCanvasStore;
  const apply = (beforeFocus?: () => void): boolean => {
    const current = useUIStore.getState();
    if (current.activeHostId !== address.satelliteId || useProjectStore.getState().activeProjectId !== projectId
      || remoteCanvasJumpUnavailable(agent, hit)) return false;
    const s = store.getState();
    // Home's store is shared between hosts and local Home. Never focus a colliding raw id there.
    if (!s.loaded || s.dataOrigin !== 'remote' || !containsCanvasHit(s.canvases, agent.id, hit)) return false;
    beforeFocus?.();
    s.setActiveCanvas(hit.canvasId);
    s.focusView(hit.viewId);
    s.selectView(hit.viewId);
    return true;
  };
  if (apply()) return;
  // CanvasView owns save flushing/failed-edit preservation and remote hydration. Wait for that boundary.
  const offStore = store.subscribe(() => {
    apply(cleanup);
  });
  const offUI = useUIStore.subscribe(() => {
    if (useUIStore.getState().activeHostId !== address.satelliteId) cleanup();
  });
  const offProject = useProjectStore.subscribe(() => {
    if (useProjectStore.getState().activeProjectId !== projectId) cleanup();
  });
  const offHost = useAnnexClientStore.subscribe(() => {
    if (remoteCanvasJumpUnavailable(agent, hit)) cleanup();
  });
  const timeout = setTimeout(() => cleanup(), 30_000);
  const cleanup = () => { offStore(); offUI(); offProject(); offHost(); clearTimeout(timeout); if (pendingJump === cleanup) pendingJump = null; };
  pendingJump = cleanup;
}
