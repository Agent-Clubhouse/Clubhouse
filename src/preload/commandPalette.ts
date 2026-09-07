import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const commandPalette = {
  commandPalette: {
  /** Listen for command palette operations from the main process. */
  onRequest: (callback: (request: { callId: string; operation: string; args: Record<string, unknown> }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: Parameters<typeof callback>[0]) => callback(request);
    ipcRenderer.on(IPC.CMD_PALETTE.REQUEST, listener);
    return () => { ipcRenderer.removeListener(IPC.CMD_PALETTE.REQUEST, listener); };
  },
  /** Send command palette operation result back to main process. */
  sendResult: (callId: string, result: { success: boolean; data?: unknown; error?: string }) => {
    ipcRenderer.send(IPC.CMD_PALETTE.RESULT, { callId, result });
  },
  },
};
