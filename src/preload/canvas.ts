import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AgentNavigationTarget, CanvasMembership, CanvasNavigationSnapshot, GroupProjectNavigationIndex } from '../shared/canvas-index-types';
import type { NavigableCanvasTargetKind } from '../shared/canvas-persistence';

const flushers = new Set<() => Promise<void>>();
ipcRenderer.on(IPC.CANVAS_CMD.FLUSH_REQUEST, (_event, requestId: string) => {
  void Promise.all([...flushers].map((flush) => flush())).then(
    () => ipcRenderer.send(IPC.CANVAS_CMD.FLUSH_RESULT, requestId, true),
    () => ipcRenderer.send(IPC.CANVAS_CMD.FLUSH_RESULT, requestId, false),
  );
});

export const canvas = {
  canvas: {
  onFlushRequested: (flush: () => Promise<void>) => {
    flushers.add(flush);
    return () => { flushers.delete(flush); };
  },
  /** Run ELK layout algorithm in the main process. */
  layoutElk: (input: {
    cards: Array<{ id: string; width: number; height: number; zoneId?: string }>;
    edges: Array<{ id: string; source: string; target: string }>;
    zones: Array<{ id: string; width: number; height: number; childIds: string[] }>;
    options?: { algorithm?: string; direction?: string; rootId?: string; layoutCenterId?: string };
  }) => ipcRenderer.invoke(IPC.CANVAS_CMD.ELK_LAYOUT, input) as Promise<{
    nodes: Array<{ id: string; x: number; y: number }>;
    edges: Array<{ id: string; path: string }>;
  }>,
  /** The canvases holding an agent's card, read from the persisted stores (Home and the agent's project). */
  getAgentCanvases: (agentId: string, projectId?: string | null) =>
    ipcRenderer.invoke(IPC.CANVAS_CMD.GET_AGENT_CANVASES, agentId, projectId ?? undefined) as Promise<CanvasMembership[]>,
  getTargetCanvases: (kind: NavigableCanvasTargetKind, targetId: string) =>
    ipcRenderer.invoke(IPC.CANVAS_CMD.GET_TARGET_CANVASES, kind, targetId) as Promise<GroupProjectNavigationIndex>,
  readForNavigation: (kind: NavigableCanvasTargetKind, targetId: string, projectId?: string) =>
    ipcRenderer.invoke(IPC.CANVAS_CMD.READ_FOR_NAVIGATION, kind, targetId, projectId) as Promise<CanvasNavigationSnapshot>,
  resolveAgentTarget: (agentId: string) =>
    ipcRenderer.invoke(IPC.CANVAS_CMD.RESOLVE_AGENT_TARGET, agentId) as Promise<AgentNavigationTarget>,
  },
};
