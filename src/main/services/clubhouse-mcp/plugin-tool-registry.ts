/**
 * Plugin Tool Registry — manages tools contributed by plugins to the Clubhouse MCP.
 *
 * Plugins register tool definitions via mcp.contributeTools(). When an agent calls
 * a plugin tool, the call is routed through IPC to the plugin's renderer-side handler.
 *
 * Tool naming: plugin__<sanitized_plugin_id>__<tool_name>
 */

import type { McpToolDefinition, McpToolResult } from './types';
import { registerToolTemplate, sanitizeId } from './tool-registry';
import { appLog } from '../log-service';

interface PluginToolEntry {
  pluginId: string;
  name: string;
  definition: Omit<McpToolDefinition, 'name'>;
}

/** Map of pluginId -> registered tools */
const pluginTools = new Map<string, PluginToolEntry[]>();

/** Pending tool call resolvers — keyed by callId */
const pendingCalls = new Map<string, {
  resolve: (result: McpToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** Default timeout for plugin tool calls (30 seconds). */
const TOOL_CALL_TIMEOUT_MS = 30_000;

let callIdCounter = 0;

/**
 * Register tools contributed by a plugin.
 * Each tool is registered as a template under the 'plugin' target kind.
 */
export function registerPluginTools(
  pluginId: string,
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): void {
  // Remove any existing tools for this plugin first
  removePluginTools(pluginId);

  const entries: PluginToolEntry[] = [];

  for (const tool of tools) {
    const entry: PluginToolEntry = {
      pluginId,
      name: tool.name,
      definition: {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
    };
    entries.push(entry);

    // Register as a tool template under the 'plugin' target kind
    registerToolTemplate(
      'plugin',
      tool.name,
      entry.definition,
      async (_targetId, _agentId, args) => {
        return invokePluginToolHandler(pluginId, tool.name, args);
      },
    );
  }

  pluginTools.set(pluginId, entries);

  appLog('core:mcp', 'info', `Plugin ${pluginId} registered ${tools.length} MCP tools`, {
    meta: { pluginId, tools: tools.map(t => t.name) },
  });
}

/**
 * Remove all tools contributed by a plugin.
 */
export function removePluginTools(pluginId: string): void {
  const existing = pluginTools.get(pluginId);
  if (existing) {
    pluginTools.delete(pluginId);
    appLog('core:mcp', 'info', `Plugin ${pluginId} removed ${existing.length} MCP tools`);
  }
}

/**
 * List tool names contributed by a plugin.
 */
export function listPluginTools(pluginId: string): string[] {
  const entries = pluginTools.get(pluginId);
  return entries ? entries.map(e => `plugin__${sanitizeId(pluginId)}__${e.name}`) : [];
}

/**
 * Invoke a plugin's tool handler via IPC.
 * The call is routed to the renderer process where the plugin's onToolCall handler runs.
 */
async function invokePluginToolHandler(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const callId = `ptc_${++callIdCounter}_${Date.now()}`;

  return new Promise<McpToolResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({
        content: [{ type: 'text', text: `Plugin tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s: ${pluginId}/${toolName}` }],
        isError: true,
      });
    }, TOOL_CALL_TIMEOUT_MS);

    pendingCalls.set(callId, { resolve, reject, timer });

    // Send IPC to renderer — the renderer bridge will route to the plugin
    const { BrowserWindow } = require('electron');
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      windows[0].webContents.send('plugin-tool-call', {
        callId,
        pluginId,
        toolName,
        args,
      });
    } else {
      pendingCalls.delete(callId);
      clearTimeout(timer);
      resolve({
        content: [{ type: 'text', text: 'No renderer window available for plugin tool call' }],
        isError: true,
      });
    }
  });
}

/**
 * Resolve a pending plugin tool call with the result from the renderer.
 * Called by the IPC handler when the plugin's onToolCall handler returns.
 */
export function resolvePluginToolCall(
  callId: string,
  result: McpToolResult,
): void {
  const pending = pendingCalls.get(callId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingCalls.delete(callId);
    pending.resolve(result);
  }
}

/** For testing: clear all registered plugin tools. */
export function _resetForTesting(): void {
  pluginTools.clear();
  for (const [, pending] of pendingCalls) {
    clearTimeout(pending.timer);
  }
  pendingCalls.clear();
  callIdCounter = 0;
}
