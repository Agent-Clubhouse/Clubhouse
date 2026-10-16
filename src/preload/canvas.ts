import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

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
  },
};
