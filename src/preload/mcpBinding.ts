import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const mcpBinding = {
  mcpBinding: {
  getBindings: () =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_BINDINGS),
  bind: (agentId: string, target: { targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.BIND, agentId, target),
  unbind: (agentId: string, targetId: string) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.UNBIND, agentId, targetId),
  registerWebview: (widgetId: string, webContentsId: string) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.REGISTER_WEBVIEW, widgetId, webContentsId),
  unregisterWebview: (widgetId: string) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.UNREGISTER_WEBVIEW, widgetId),
  setInstructions: (agentId: string, targetId: string, instructions: Record<string, string>) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_INSTRUCTIONS, agentId, targetId, instructions),
  setDisabledTools: (agentId: string, targetId: string, disabledTools: string[]) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_DISABLED_TOOLS, agentId, targetId, disabledTools),
  onBindingsChanged: (callback: (bindings: Array<{
    agentId: string;
    targetId: string;
    targetKind: 'browser' | 'agent' | 'terminal' | 'group-project' | 'agent-queue';
    label: string;
  }>) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, bindings: Parameters<typeof callback>[0]) => callback(bindings);
    ipcRenderer.on(IPC.MCP_BINDING.BINDINGS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.MCP_BINDING.BINDINGS_CHANGED, listener); };
  },
  onToolActivity: (callback: (activity: {
    sourceAgentId: string;
    targetId: string;
    direction: 'forward' | 'reverse';
    toolSuffix: string;
    timestamp: number;
  }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, activity: Parameters<typeof callback>[0]) => callback(activity);
    ipcRenderer.on(IPC.MCP_BINDING.TOOL_ACTIVITY, listener);
    return () => { ipcRenderer.removeListener(IPC.MCP_BINDING.TOOL_ACTIVITY, listener); };
  },
  },
};
