/**
 * Plugin MCP host: holds each active plugin's capability token, and builds
 * the `api.mcp` object that uses it.
 *
 * Main resolves the calling plugin from the token on every plugin-mcp call
 * (see plugin-mcp-tokens in main). Tokens live only in this module's closure:
 * plugins share one renderer and one window.clubhouse, and nothing here is
 * reachable from either. To get a token you need the issuer secret, which the
 * host claims once per page load, before any plugin code is loaded
 * (plugin-loader calls claimPluginMcpIssuer first thing). Main refuses a
 * second claim from the same page.
 *
 * Main keeps one tool set per plugin, but the loader activates one context
 * per plugin and project, so a plugin holds one token for all its contexts.
 * The token is revoked, and main removes the plugin's tools, when the last
 * of them deactivates.
 */

import type { PluginContext, PluginAPI } from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';

type McpAPI = PluginAPI['mcp'];

let issuer: Promise<string> | null = null;

interface TokenEntry {
  token: Promise<string>;
  contexts: Set<PluginContext>;
}

/** Live tokens, per plugin. */
const tokens = new Map<string, TokenEntry>();
/** Live onToolCall handlers, per plugin, across its contexts. */
const handlerCounts = new Map<string, number>();
let fallbackInstalled = false;

const ignore = (): undefined => undefined;

type Bridge = Window['clubhouse']['pluginMcp'];

/**
 * The bridge methods as they were when the host claimed the issuer, before
 * any plugin code ran: plugin code that later replaces a method on
 * window.clubhouse.pluginMcp can't see the tokens the host passes.
 */
let bridge: Bridge | null = null;
const mcp = (): Bridge => bridge ?? window.clubhouse.pluginMcp;

/** Claim this page's issuer secret. Idempotent; the first call must come before plugin code loads. */
export function claimPluginMcpIssuer(): Promise<string> {
  if (!issuer) {
    issuer = (async () => {
      bridge = { ...window.clubhouse.pluginMcp };
      return bridge.claimIssuer();
    })();
    issuer.catch((err: unknown) => {
      rendererLog('core:plugins', 'warn', 'Could not claim the plugin MCP issuer; plugin MCP tools are unavailable', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  }
  return issuer;
}

/**
 * The plugin's token, issued on its first context's activation. Each context
 * holds it until that context deactivates.
 */
function acquireToken(ctx: PluginContext): Promise<string> {
  let entry = tokens.get(ctx.pluginId);
  if (!entry) {
    const token = claimPluginMcpIssuer().then(secret => mcp().issueToken(secret, ctx.pluginId));
    // Calls are routed to this page only once it holds a token.
    token.then(ensureFallbackResponder, ignore);
    entry = { token, contexts: new Set() };
    tokens.set(ctx.pluginId, entry);
  }
  if (!entry.contexts.has(ctx)) {
    entry.contexts.add(ctx);
    const held = entry;
    ctx.subscriptions.push({
      dispose() {
        if (!held.contexts.delete(ctx) || held.contexts.size > 0) return;
        if (tokens.get(ctx.pluginId) === held) tokens.delete(ctx.pluginId);
        void held.token.then(t => mcp().revokeToken(t)).catch(ignore);
      },
    });
  }
  return entry.token;
}

/**
 * Answers, with an error, any tool call for a plugin that has no live
 * onToolCall handler: a call that arrives after its plugin deactivated, but
 * before main has removed the tools, would otherwise wait out main's timeout.
 * Installed once, for the renderer's lifetime.
 */
function ensureFallbackResponder(): void {
  if (fallbackInstalled) return;
  fallbackInstalled = true;
  mcp().onToolCall((data) => {
    if ((handlerCounts.get(data.pluginId) ?? 0) > 0) return;
    // No token means it was revoked, and main settled the call already.
    const entry = tokens.get(data.pluginId);
    if (!entry) return;
    void entry.token.then(token => mcp().sendToolResult(token, data.callId, {
      content: [{ type: 'text', text: `Plugin ${data.pluginId} has no active tool handler` }],
      isError: true,
    })).catch(ignore);
  });
}

/** Build `api.mcp` for a context of a plugin that holds `mcp.tools`. */
export function createMcpAPI(ctx: PluginContext): McpAPI {
  const token = acquireToken(ctx);
  return {
    async contributeTools(tools) {
      await mcp().contributeTools(await token, tools);
    },
    async removeTools() {
      await mcp().removeTools(await token);
    },
    async listContributedTools() {
      return mcp().listTools(await token);
    },
    onToolCall(handler) {
      handlerCounts.set(ctx.pluginId, (handlerCounts.get(ctx.pluginId) ?? 0) + 1);
      const cleanup = mcp().onToolCall(async (data) => {
        if (data.pluginId !== ctx.pluginId) return;
        let result: Awaited<ReturnType<typeof handler>>;
        try {
          result = await handler(data.toolName, data.args);
        } catch (err) {
          result = {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            isError: true,
          };
        }
        const held = await token.catch(ignore);
        if (held) mcp().sendToolResult(held, data.callId, result);
      });
      let disposed = false;
      const disposable = {
        dispose() {
          if (disposed) return;
          disposed = true;
          cleanup();
          const left = (handlerCounts.get(ctx.pluginId) ?? 1) - 1;
          if (left > 0) handlerCounts.set(ctx.pluginId, left);
          else handlerCounts.delete(ctx.pluginId);
        },
      };
      ctx.subscriptions.push(disposable);
      return disposable;
    },
  };
}

/** For tests: forget the issuer, tokens and handler state. */
export function _resetPluginMcpStateForTests(): void {
  issuer = null;
  bridge = null;
  tokens.clear();
  handlerCounts.clear();
  fallbackInstalled = false;
}
