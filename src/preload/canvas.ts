import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { CanvasMembership } from '../shared/canvas-index-types';

export const canvas = {
  canvas: {
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
  },
};
