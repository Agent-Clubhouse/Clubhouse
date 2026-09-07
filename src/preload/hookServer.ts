import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const hookServer = {
  hookServer: {
  /**
   * Listen for "agents need restart" events broadcast when the user toggles
   * the hook server enable setting.  Payload includes the affected agentIds
   * and whether the toggle went to enabled or disabled.  Renderer should
   * surface a non-blocking notice and offer per-agent restart — do NOT
   * auto-restart, which would lose mid-task work.
   */
  onAgentsNeedRestart: (callback: (payload: { reason: 'enabled' | 'disabled'; agentIds: string[] }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { reason: 'enabled' | 'disabled'; agentIds: string[] }) =>
      callback(payload);
    ipcRenderer.on(IPC.HOOK_SERVER.AGENTS_NEED_RESTART, listener);
    return () => { ipcRenderer.removeListener(IPC.HOOK_SERVER.AGENTS_NEED_RESTART, listener); };
  },
},
};

