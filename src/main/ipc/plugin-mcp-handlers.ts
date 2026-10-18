/**
 * IPC handlers for plugin MCP tool contribution (v0.9+).
 */

import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import {
  registerPluginTools,
  removePluginTools,
  listPluginTools,
  resolvePluginToolCall,
} from '../services/clubhouse-mcp/plugin-tool-registry';
import {
  claimIssuer,
  issueToken,
  onPluginTokensRevoked,
  requirePluginForToken,
  resolveToken,
  revokeToken,
  revokeWebContents,
} from '../services/clubhouse-mcp/plugin-mcp-tokens';
import { withValidatedArgs, stringArg, arrayArg, objectArg } from './validation';
import { appLog } from '../services/log-service';

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

type ToolResultMessage = {
  token: string;
  callId: string;
  result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
};

const toolResultArg = objectArg<ToolResultMessage>({
  validate: (msg, argName) => {
    if (typeof msg.token !== 'string' || !msg.token) throw new Error(`${argName}.token must be a non-empty string`);
    if (typeof msg.callId !== 'string' || !msg.callId) throw new Error(`${argName}.callId must be a non-empty string`);
    const result = msg.result as unknown;
    if (!result || typeof result !== 'object' || !Array.isArray((result as { content?: unknown }).content)) {
      throw new Error(`${argName}.result.content must be an array`);
    }
  },
});

// Renderer sends back the result of a plugin tool call. A send has no reply
// to carry an error, and a throw here would surface as an uncaught exception
// in main, so a rejected message is logged and dropped. Only the plugin the
// call was sent to can answer it: the token must belong to that plugin.
function onToolResult(event: Electron.IpcMainEvent, data: unknown): void {
  let message: ToolResultMessage;
  let pluginId: string;
  try {
    message = toolResultArg(data, 'toolResult');
    const owner = resolveToken(message.token);
    if (!owner || owner.webContentsId !== event.sender.id) throw new Error('unknown or revoked token');
    pluginId = owner.pluginId;
  } catch (err) {
    appLog('core:mcp', 'warn', 'Ignoring rejected plugin tool result', {
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  if (!resolvePluginToolCall(message.callId, message.result, pluginId)) {
    appLog('core:mcp', 'warn', 'Ignoring plugin tool result for a call that plugin does not own', {
      meta: { pluginId },
    });
  }
}

/**
 * Only an application window's page can claim the issuer, not a webview or
 * a detached WebContents.
 */
function assertCallerIsAppWindow(event: Electron.IpcMainInvokeEvent): void {
  if (!BrowserWindow.fromWebContents(event.sender)) {
    throw new Error('Plugin MCP issuer rejected: caller is not an application window');
  }
}

/** Pages whose navigation and teardown already revoke their tokens. */
const trackedPages = new Set<number>();

function revokeOnPageChange(sender: Electron.WebContents): void {
  const id = sender.id;
  if (trackedPages.has(id)) return;
  trackedPages.add(id);
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) revokeWebContents(id);
  });
  sender.once('destroyed', () => {
    trackedPages.delete(id);
    revokeWebContents(id);
  });
}

let stopRemovingOnRevoke: (() => void) | null = null;

const HANDLED_CHANNELS = [
  IPC.PLUGIN_MCP.CLAIM_ISSUER,
  IPC.PLUGIN_MCP.ISSUE_TOKEN,
  IPC.PLUGIN_MCP.REVOKE_TOKEN,
  IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS,
  IPC.PLUGIN_MCP.REMOVE_TOOLS,
  IPC.PLUGIN_MCP.LIST_TOOLS,
] as const;

/**
 * Registers the plugin MCP channels. Idempotent: it replaces its own
 * handlers and listener, since ipcMain.handle throws on a second handler for
 * a channel.
 *
 * Every call names its plugin by capability token (see plugin-mcp-tokens),
 * never by a pluginId argument, and `mcp.tools` is checked on every
 * operation against the manifest main trusts.
 */
export function registerPluginMcpHandlers(): void {
  for (const channel of HANDLED_CHANNELS) ipcMain.removeHandler(channel);
  ipcMain.removeListener(IPC.PLUGIN_MCP.TOOL_RESULT, onToolResult);

  // A plugin's tools go when its last token does: deactivation in every
  // window, uninstall, or reload of the page that held it.
  stopRemovingOnRevoke?.();
  stopRemovingOnRevoke = onPluginTokensRevoked((pluginId, remaining) => {
    if (remaining === 0) removePluginTools(pluginId);
  });

  ipcMain.handle(IPC.PLUGIN_MCP.CLAIM_ISSUER, (event) => {
    assertCallerIsAppWindow(event);
    const secret = claimIssuer(event.sender.id);
    revokeOnPageChange(event.sender);
    return secret;
  });

  ipcMain.handle(IPC.PLUGIN_MCP.ISSUE_TOKEN, withValidatedArgs(
    [stringArg(), stringArg()],
    async (event, issuerSecret: string, pluginId: string) => issueToken(event.sender.id, issuerSecret, pluginId),
  ));

  ipcMain.handle(IPC.PLUGIN_MCP.REVOKE_TOKEN, withValidatedArgs(
    [stringArg()],
    async (event, token: string) => {
      revokeToken(token, event.sender.id);
    },
  ));

  ipcMain.handle(IPC.PLUGIN_MCP.CONTRIBUTE_TOOLS, withValidatedArgs(
    [stringArg(), pluginToolArrayArg()],
    async (event, token: string, tools: PluginToolDef[]) => {
      registerPluginTools(requirePluginForToken(token, event.sender.id), tools);
    },
  ));

  ipcMain.handle(IPC.PLUGIN_MCP.REMOVE_TOOLS, withValidatedArgs(
    [stringArg()],
    async (event, token: string) => {
      removePluginTools(requirePluginForToken(token, event.sender.id));
    },
  ));

  ipcMain.handle(IPC.PLUGIN_MCP.LIST_TOOLS, withValidatedArgs(
    [stringArg()],
    async (event, token: string) => listPluginTools(requirePluginForToken(token, event.sender.id)),
  ));

  ipcMain.on(IPC.PLUGIN_MCP.TOOL_RESULT, onToolResult);
}

/** For testing. */
export function _resetForTesting(): void {
  trackedPages.clear();
  stopRemovingOnRevoke?.();
  stopRemovingOnRevoke = null;
}
