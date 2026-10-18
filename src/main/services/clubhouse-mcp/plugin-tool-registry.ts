/**
 * Plugin Tool Registry — manages tools contributed by plugins to the Clubhouse MCP.
 *
 * Plugins register tool definitions via mcp.contributeTools(). When an agent calls
 * a plugin tool, the call is routed through IPC to the plugin's renderer-side handler.
 *
 * Tool naming: plugin__<sanitized_plugin_id>__<tool_name>
 *
 * Each plugin's tools are a template set of their own, under target kind
 * 'plugin' and target id = the pluginId: a binding to plugin X exposes X's
 * tools and no other plugin's, and two plugins can both have a `lookup`.
 */

import { randomUUID } from 'crypto';
import { webContents } from 'electron';
import type { McpToolDefinition, McpToolResult } from './types';
import { setTargetToolTemplates, clearTargetToolTemplates, sanitizeId, type ToolTemplate } from './tool-registry';
import { webContentsIdForPlugin } from './plugin-mcp-tokens';
import { appLog } from '../log-service';
import { getManifest } from '../plugin-manifest-registry';
import { IPC } from '../../../shared/ipc-channels';

interface PluginToolEntry {
  pluginId: string;
  name: string;
  definition: Omit<McpToolDefinition, 'name'>;
}

/** Map of pluginId -> registered tools */
const pluginTools = new Map<string, PluginToolEntry[]>();

/** Pending tool call resolvers — keyed by callId */
const pendingCalls = new Map<string, {
  pluginId: string;
  resolve: (result: McpToolResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

/** Default timeout for plugin tool calls (30 seconds). */
const TOOL_CALL_TIMEOUT_MS = 30_000;

/**
 * Tool names a plugin may use: what MCP clients accept in a tool name, less
 * a leading '_' and any '__'. Tools are named plugin__<id>__<tool>, and the
 * id is sanitized ('-' becomes '_'), so without those rules 'acme-' + 'x'
 * and 'acme' + '_x' would build the same name, as would 'acme--notes' +
 * 'search' and 'acme' + 'notes__search'.
 */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9-](?:[A-Za-z0-9-]|_(?!_)){0,63}$/;

/**
 * Register tools contributed by a plugin, replacing its previous set.
 * All or nothing: the whole set is validated and built first, then swapped
 * in one step, so a failed contribution leaves the previous set in place.
 */
export function registerPluginTools(
  pluginId: string,
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
): void {
  const manifest = getManifest(pluginId);
  if (!manifest || !manifest.permissions?.includes('mcp.tools')) {
    throw new Error(`Plugin '${pluginId}' requires 'mcp.tools' permission to contribute MCP tools`);
  }

  const entries: PluginToolEntry[] = [];
  const templates: ToolTemplate[] = [];
  const names = new Set<string>();

  for (const tool of tools) {
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      throw new Error(`Plugin '${pluginId}' tool name "${tool.name}" must match ${TOOL_NAME_PATTERN}`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Plugin '${pluginId}' contributed tool "${tool.name}" twice`);
    }
    names.add(tool.name);

    const entry: PluginToolEntry = {
      pluginId,
      name: tool.name,
      definition: {
        description: tool.description,
        inputSchema: {
          type: 'object' as const,
          properties: (tool.inputSchema.properties as Record<string, unknown>) ?? {},
          required: (tool.inputSchema.required as string[]) ?? [],
        },
      },
    };
    entries.push(entry);

    templates.push({
      nameSuffix: tool.name,
      definition: entry.definition,
      handler: async (_targetId, _agentId, args) => invokePluginToolHandler(pluginId, tool.name, args),
    });
  }

  setTargetToolTemplates('plugin', pluginId, templates);
  pluginTools.set(pluginId, entries);

  appLog('core:mcp', 'info', `Plugin ${pluginId} registered ${tools.length} MCP tools`, {
    meta: { pluginId, tools: tools.map(t => t.name) },
  });
}

/**
 * Remove all tools contributed by a plugin.
 */
export function removePluginTools(pluginId: string): void {
  // Calls already sent to the plugin will never be answered once its tools
  // are gone: settle them now instead of letting each wait out the timeout.
  for (const [callId, pending] of pendingCalls) {
    if (pending.pluginId !== pluginId) continue;
    clearTimeout(pending.timer);
    pendingCalls.delete(callId);
    pending.resolve({
      content: [{ type: 'text', text: `Plugin ${pluginId} was removed before answering the tool call` }],
      isError: true,
    });
  }

  clearTargetToolTemplates('plugin', pluginId);
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
 * The call goes to the page holding the plugin's token, where its onToolCall
 * handler runs.
 */
async function invokePluginToolHandler(
  pluginId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const callId = randomUUID();

  return new Promise<McpToolResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({
        content: [{ type: 'text', text: `Plugin tool call timed out after ${TOOL_CALL_TIMEOUT_MS / 1000}s: ${pluginId}/${toolName}` }],
        isError: true,
      });
    }, TOOL_CALL_TIMEOUT_MS);

    pendingCalls.set(callId, { pluginId, resolve, reject, timer });

    const hostId = webContentsIdForPlugin(pluginId);
    const host = hostId === undefined ? undefined : webContents.fromId(hostId);
    if (host && !host.isDestroyed()) {
      host.send(IPC.PLUGIN_MCP.TOOL_CALL, {
        callId,
        pluginId,
        toolName,
        args,
      });
    } else {
      pendingCalls.delete(callId);
      clearTimeout(timer);
      resolve({
        content: [{ type: 'text', text: `Plugin ${pluginId} is not active in any window` }],
        isError: true,
      });
    }
  });
}

/**
 * Resolve a pending plugin tool call with the result from the renderer.
 * Only the plugin the call was sent to can answer it: `fromPluginId` is the
 * plugin resolved from the sender's token. Returns false, leaving the call
 * pending, for an unknown call or one owned by another plugin.
 */
export function resolvePluginToolCall(
  callId: string,
  result: McpToolResult,
  fromPluginId: string,
): boolean {
  const pending = pendingCalls.get(callId);
  if (!pending || pending.pluginId !== fromPluginId) return false;
  clearTimeout(pending.timer);
  pendingCalls.delete(callId);
  pending.resolve(result);
  return true;
}

/** For testing: clear all registered plugin tools. */
export function _resetForTesting(): void {
  pluginTools.clear();
  for (const [, pending] of pendingCalls) {
    clearTimeout(pending.timer);
  }
  pendingCalls.clear();
}
