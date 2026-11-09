import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-channels';
import type { AgentMcpConnection, DispatcherLink } from '../shared/types';
import type { McpUnbindCause, McpUnbindResult } from '../shared/mcp-unbind';
import type { AgentConnectionSources, ConnectionSourceKind, RemoveConnectionSourceResult } from '../shared/connection-sources';
import type { ConnectionDirection } from '../shared/connection-grants';

export const mcpBinding = {
  mcpBinding: {
  getBindings: () =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_BINDINGS),
  bind: (agentId: string, target: { targetId: string; targetKind: string; label: string; agentName?: string; targetName?: string; projectName?: string }) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.BIND, agentId, target),
  unbind: (agentId: string, targetId: string, cause?: McpUnbindCause): Promise<McpUnbindResult | undefined> =>
    cause
      ? ipcRenderer.invoke(IPC.MCP_BINDING.UNBIND, agentId, targetId, cause)
      : ipcRenderer.invoke(IPC.MCP_BINDING.UNBIND, agentId, targetId),
  registerWebview: (widgetId: string, webContentsId: string) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.REGISTER_WEBVIEW, widgetId, webContentsId),
  unregisterWebview: (widgetId: string) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.UNREGISTER_WEBVIEW, widgetId),
  setInstructions: (agentId: string, targetId: string, instructions: Record<string, string>) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_INSTRUCTIONS, agentId, targetId, instructions),
  /**
   * One direction's disabled tools; agent-to-agent ones are saved in the connection store (D129).
   * `restore`: a canvas wire bound again. `start`: a wire just drawn, which starts with wake on too.
   */
  setDisabledTools: (agentId: string, targetId: string, disabledTools: string[], options?: { restore?: boolean; start?: boolean }) =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_DISABLED_TOOLS, agentId, targetId, disabledTools, ...(options ? [options] : [])),
  /** Per-direction connection permissions touching an agent (D129, #2972). */
  getConnectionGrants: (agentId: string): Promise<ConnectionDirection[]> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_CONNECTION_GRANTS, agentId),
  /** One direction's saved tools changed (D129): a canvas updates its own copy of that wire. */
  onConnectionGrantsChanged: (callback: (from: string, to: string, disabledTools: string[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, from: string, to: string, disabledTools: string[]) => callback(from, to, disabledTools);
    ipcRenderer.on(IPC.MCP_BINDING.CONNECTION_GRANTS_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.MCP_BINDING.CONNECTION_GRANTS_CHANGED, listener); };
  },
  /** Make a one-way connection two-way: the user's own link for the other direction (#2972). */
  makeTwoWay: (fromAgentId: string, toAgentId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.MAKE_TWO_WAY, fromAgentId, toAgentId),
  /** Connect an agent here with one on another machine (`agentId@machine`), one way or both (#3064). */
  connectAcrossMachines: (agentId: string, address: string, options: { twoWay?: boolean; name?: string }): Promise<void> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.CONNECT_ACROSS_MACHINES, agentId, address, options),
  /** Remove the user's links between an agent here and one on another machine, both ways (#3064). */
  disconnectAcrossMachines: (agentId: string, address: string): Promise<void> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.DISCONNECT_ACROSS_MACHINES, agentId, address),
  /** Set the tools turned off on one direction with an agent on another machine: `outgoing` from this agent (#3064). */
  setToolsAcrossMachines: (agentId: string, address: string, outgoing: boolean, disabledTools: string[]): Promise<void> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_TOOLS_ACROSS_MACHINES, agentId, address, outgoing, disabledTools),
  /** Turn Wake it on or off for one direction between two agents on this computer (#3215). */
  setLocalWake: (fromAgentId: string, toAgentId: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.SET_LOCAL_WAKE, fromAgentId, toAgentId, on),
  /** Wires the orchestrator connection tools made and alone own; the user may remove these (#2232). */
  getToolConnections: (): Promise<Array<{ agentId: string; targetId: string }>> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_TOOL_CONNECTIONS),
  /** Links the Dispatcher made that the user may remove, suspended ones included (#2661). */
  getDispatcherLinks: (): Promise<DispatcherLink[]> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_DISPATCHER_LINKS),
  /** The sources behind an agent's connections, both directions (#2744). */
  getConnectionSources: (agentId: string): Promise<AgentConnectionSources> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_CONNECTION_SOURCES, agentId),
  /** Remove one source of one connection; others stay (#2744). */
  removeConnectionSource: (agentId: string, targetId: string, kind: ConnectionSourceKind): Promise<RemoveConnectionSourceResult> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.REMOVE_CONNECTION_SOURCE, agentId, targetId, kind),
  getAgentConnection: (agentId: string): Promise<AgentMcpConnection | null> =>
    ipcRenderer.invoke(IPC.MCP_BINDING.GET_AGENT_CONNECTION, agentId),
  onAgentConnectionChanged: (callback: (agentId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, agentId: string) => callback(agentId);
    ipcRenderer.on(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, listener);
    return () => { ipcRenderer.removeListener(IPC.MCP_BINDING.AGENT_CONNECTION_CHANGED, listener); };
  },
  onBindingsChanged: (callback: (bindings: Array<{
    agentId: string;
    targetId: string;
    targetKind: 'browser' | 'agent' | 'terminal' | 'group-project';
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
