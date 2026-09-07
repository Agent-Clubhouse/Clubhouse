import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';

export const pluginMcp = {
  pluginMcp: {
  contributeTools: (pluginId: string, tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, pluginId, tools),
  removeTools: (pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.REMOVE_TOOLS, pluginId),
  listTools: (pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.LIST_TOOLS, pluginId) as Promise<string[]>,
  onToolCall: (callback: (data: { callId: string; pluginId: string; toolName: string; args: Record<string, unknown> }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { callId: string; pluginId: string; toolName: string; args: Record<string, unknown> }) => callback(data);
    ipcRenderer.on(IPC.PLUGIN_MCP.TOOL_CALL, listener);
    return () => { ipcRenderer.removeListener(IPC.PLUGIN_MCP.TOOL_CALL, listener); };
  },
  sendToolResult: (callId: string, result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean }) =>
    ipcRenderer.send(IPC.PLUGIN_MCP.TOOL_RESULT, { callId, result }),
  },
};
