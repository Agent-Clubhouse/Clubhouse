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

/** Where the plugin host runs: the main window, showing the app's own page. */
export interface PluginMcpHost {
  getMainWebContentsId: () => number | undefined;
  /** The URL the main window loads (MAIN_WINDOW_WEBPACK_ENTRY). */
  entryUrl: string;
}

let host: PluginMcpHost | null = null;

/** Tell the handlers which page is the plugin host. Until then, no issuer can be claimed. */
export function configurePluginMcpHost(next: PluginMcpHost): void {
  host = next;
}

/**
 * A URL reduced to the document it names, for comparing the main frame's URL
 * with the entry URL, or '' if it doesn't parse.
 *
 * Query and hash are dropped. The pathname is decoded, because Node (which
 * parses the entry URL here) and Chromium (which reports the frame's URL)
 * don't percent-encode the same characters ({ } ^ | among them). The host
 * and a Windows drive letter (/C: vs /c:) compare case-insensitively. This
 * only normalizes spelling: the webContents, main-frame and BrowserWindow
 * checks are what carry the security.
 */
export function documentUrl(url: string): string {
  try {
    const u = new URL(url);
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      // Malformed escapes: compare as spelled.
    }
    pathname = pathname.replace(/^\/([A-Za-z]):/, (_m, drive: string) => `/${drive.toLowerCase()}:`);
    return `${u.protocol}//${u.host.toLowerCase()}${pathname}`;
  } catch {
    return '';
  }
}

/**
 * Only the plugin host can claim the issuer: the main window's top frame,
 * showing the app's entry page. Not a pop-out, not a window.open child (it
 * inherits the preload), not a webview or a subframe, and not the main
 * window after it navigated somewhere else.
 */
function assertCallerIsPluginHost(event: Electron.IpcMainInvokeEvent): void {
  const mainId = host?.getMainWebContentsId();
  const frame = event.senderFrame;
  const ok = !!host && mainId !== undefined && event.sender.id === mainId
    && !!BrowserWindow.fromWebContents(event.sender)
    && !!frame && frame === event.sender.mainFrame
    && documentUrl(frame.url) !== '' && documentUrl(frame.url) === documentUrl(host.entryUrl);
  if (!ok) {
    appLog('core:mcp', 'warn', 'Rejected plugin MCP issuer claim: caller is not the plugin host', {
      meta: { webContentsId: event.sender.id, url: frame?.url?.slice(0, 200) },
    });
    throw new Error('Plugin MCP issuer rejected: caller is not the plugin host');
  }
}

/** Pages whose navigation and teardown already revoke their tokens. */
const trackedPages = new Set<number>();

/**
 * Revoke a page's issuer and tokens when its document is replaced: on a
 * committed main-frame navigation (did-navigate fires for the main frame
 * only, and not for in-page navigations), not when one starts, since a
 * navigation that never commits leaves the old page and its plugins
 * running. And when the page is destroyed.
 */
function revokeOnPageChange(sender: Electron.WebContents): void {
  const id = sender.id;
  if (trackedPages.has(id)) return;
  trackedPages.add(id);
  sender.on('did-navigate', () => revokeWebContents(id));
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
    assertCallerIsPluginHost(event);
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
  host = null;
  trackedPages.clear();
  stopRemovingOnRevoke?.();
  stopRemovingOnRevoke = null;
}
