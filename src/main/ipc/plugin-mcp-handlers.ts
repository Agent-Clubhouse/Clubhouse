/**
 * IPC handlers for plugin MCP tool contribution (v0.9+).
 */

import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import {
  registerPluginTools,
  removePluginTools,
  listPluginTools,
  resolvePluginToolCall,
} from '../services/clubhouse-mcp/plugin-tool-registry';
import { withValidatedArgs, stringArg, arrayArg, objectArg } from './validation';

export function registerPluginMcpHandlers(): void {
  ipcMain.handle(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS,
    async (_event: Electron.IpcMainInvokeEvent, pluginId: string, tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) => {
      registerPluginTools(pluginId, tools);
    },
  );

  ipcMain.handle(IPC.PLUGIN_MCP.REMOVE_TOOLS, withValidatedArgs(
    [stringArg()],
    async (_event, pluginId: string) => {
      removePluginTools(pluginId);
    },
  ));

  ipcMain.handle(IPC.PLUGIN_MCP.LIST_TOOLS, withValidatedArgs(
    [stringArg()],
    async (_event, pluginId: string) => {
      return listPluginTools(pluginId);
    },
  ));

  // Renderer sends back the result of a plugin tool call
  ipcMain.on(IPC.PLUGIN_MCP.TOOL_RESULT, (_event, data: { callId: string; result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } }) => {
    resolvePluginToolCall(data.callId, data.result);
  });
}
