import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const canvas = {
  canvas: {
  /** Listen for canvas commands from the main process (assistant). */
  onCommand: (callback: (request: { callId: string; command: string; args: Record<string, unknown> }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) => callback(request);
    ipcRenderer.on(IPC.CANVAS_CMD.REQUEST, listener);
    return () => { ipcRenderer.removeListener(IPC.CANVAS_CMD.REQUEST, listener); };
  },
  /** Send canvas command result back to main process. */
  sendCommandResult: (callId: string, result: { success: boolean; data?: unknown; error?: string }) => {
    ipcRenderer.send(IPC.CANVAS_CMD.RESULT, { callId, result });
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
  },
};
