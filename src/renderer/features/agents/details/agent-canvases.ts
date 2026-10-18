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
import { isRemoteProjectId } from '../../../stores/remoteProjectStore';
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
