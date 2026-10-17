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

type PluginToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };

function pluginToolArrayArg(): (value: unknown, argName: string) => PluginToolDef[] {
  const inner = arrayArg(
    objectArg<PluginToolDef>({
      validate: (tool, argName) => {
        if (typeof tool.name !== 'string' || !tool.name) {
          throw new Error(`${argName}.name must be a non-empty string`);
        }
        if (typeof tool.description !== 'string' || !tool.description) {
          throw new Error(`${argName}.description must be a non-empty string`);
        }
        if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
          throw new Error(`${argName}.inputSchema must be an object`);
        }
      },
    }),
  );
  return inner;
}

type ToolResultMessage = { callId: string; result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } };

// Renderer sends back the result of a plugin tool call
function onToolResult(_event: Electron.IpcMainEvent, data: ToolResultMessage): void {
  resolvePluginToolCall(data.callId, data.result);
}

/**
 * Registers the plugin MCP channels. Idempotent: it replaces its own
 * handlers and listener, since ipcMain.handle throws on a second handler for
 * a channel. Permission is enforced in registerPluginTools, against the
 * manifest main trusts (`mcp.tools`).
 */
export function registerPluginMcpHandlers(): void {
  ipcMain.removeHandler(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS);
  ipcMain.removeHandler(IPC.PLUGIN_MCP.REMOVE_TOOLS);
  ipcMain.removeHandler(IPC.PLUGIN_MCP.LIST_TOOLS);
  ipcMain.removeListener(IPC.PLUGIN_MCP.TOOL_RESULT, onToolResult);

  ipcMain.handle(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, withValidatedArgs(
    [stringArg(), pluginToolArrayArg()],
    async (_event, pluginId: string, tools: PluginToolDef[]) => {
      registerPluginTools(pluginId, tools);
    },
  ));

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

  ipcMain.on(IPC.PLUGIN_MCP.TOOL_RESULT, onToolResult);
}
