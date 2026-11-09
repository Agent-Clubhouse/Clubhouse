import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AccessLevel } from '../shared/agent-access';

type PluginToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
type PluginToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Every plugin call carries a capability token, not a pluginId: main
 * resolves the plugin from the token. Only the renderer's plugin host can
 * claim the issuer (once per page load) and so obtain tokens; it keeps them
 * out of reach of plugin code.
 */
export const pluginMcp = {
  pluginMcp: {
  claimIssuer: () =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.CLAIM_ISSUER) as Promise<string>,
  issueToken: (issuerSecret: string, pluginId: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.ISSUE_TOKEN, issuerSecret, pluginId) as Promise<string>,
  revokeToken: (token: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.REVOKE_TOKEN, token) as Promise<void>,
  contributeTools: (token: string, tools: PluginToolDef[]) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, token, tools),
  removeTools: (token: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.REMOVE_TOOLS, token),
  listTools: (token: string) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.LIST_TOOLS, token) as Promise<string[]>,
  onToolCall: (callback: (data: { callId: string; pluginId: string; toolName: string; args: Record<string, unknown>; callerAccess?: AccessLevel }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { callId: string; pluginId: string; toolName: string; args: Record<string, unknown>; callerAccess?: AccessLevel }) => callback(data);
    ipcRenderer.on(IPC.PLUGIN_MCP.TOOL_CALL, listener);
    return () => { ipcRenderer.removeListener(IPC.PLUGIN_MCP.TOOL_CALL, listener); };
  },
  sendToolResult: (token: string, callId: string, result: PluginToolResult) =>
    ipcRenderer.send(IPC.PLUGIN_MCP.TOOL_RESULT, { token, callId, result }),
  checkCaller: (token: string, callId: string, check: { action: string; agentId: string } | { action: string; projectPath: string } | { filePath: string; op: 'write' | 'delete' | 'exec' }) =>
    ipcRenderer.invoke(IPC.PLUGIN_MCP.CHECK_CALLER, token, callId, check) as Promise<{ ok: boolean; message?: string; over?: boolean }>,
  onCallEnded: (callback: (data: { pluginId: string; callId: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: { pluginId: string; callId: string }) => callback(data);
    ipcRenderer.on(IPC.PLUGIN_MCP.CALL_ENDED, listener);
    return () => { ipcRenderer.removeListener(IPC.PLUGIN_MCP.CALL_ENDED, listener); };
  },
  },
};
