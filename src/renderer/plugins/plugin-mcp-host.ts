/**
 * Plugin MCP host: holds each active plugin's capability token, and builds
 * the `api.mcp` object that uses it.
 *
 * Main resolves the calling plugin from the token on every plugin-mcp call
 * (see plugin-mcp-tokens in main). To get a token you need the issuer
 * secret, which the host claims once per page load, before any plugin code
 * is loaded (plugin-loader calls claimPluginMcpIssuer first thing). Main
 * refuses a second claim. The host keeps the secret and the tokens in this
 * module's closure, never on window.clubhouse or the plugin API.
 *
 * What this protects against: one plugin acting as another by accident or
 * by casual spoofing (passing another plugin's id). It is not isolation from
 * a malicious plugin. Plugins share this JS realm, so a plugin that patches
 * built-ins can still reach values the host handles. The host captures the
 * built-ins it uses at module load and never resolves a promise with a
 * secret, which closes the obvious routes (Promise.prototype.then, await,
 * Map.prototype.get), but a shared realm can't be made airtight. Real
 * isolation is a separate change.
 *
 * Main keeps one tool set per plugin, but the loader activates one context
 * per plugin and project, so a plugin holds one token for all its contexts.
 * The token is revoked, and main removes the plugin's tools, when the last
 * of them deactivates.
 */

import type { PluginContext, PluginAPI } from '../../shared/plugin-types';
import { rendererLog } from './renderer-logger';

type McpAPI = PluginAPI['mcp'];
type Bridge = Window['clubhouse']['pluginMcp'];

// ── Built-ins, captured before any plugin code runs ────────────────────
// Called through these, a later patch of the prototype method by plugin
// code never sees the secret or a token.

const uncurryThis = Function.prototype.bind.bind(Function.prototype.call) as
  (fn: (...args: never[]) => unknown) => (self: unknown, ...args: unknown[]) => unknown;
const NativePromise = Promise;
const promiseThen = uncurryThis(Promise.prototype.then) as
  (p: Promise<unknown>, onValue: (value: unknown) => void, onError: (err: unknown) => void) => void;
const mapGet = uncurryThis(Map.prototype.get) as <V>(map: Map<string, V>, key: string) => V | undefined;
const mapSet = uncurryThis(Map.prototype.set) as <V>(map: Map<string, V>, key: string, value: V) => void;
const mapDelete = uncurryThis(Map.prototype.delete) as (map: Map<string, unknown>, key: string) => boolean;
const setHas = uncurryThis(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const setAdd = uncurryThis(Set.prototype.add) as <T>(set: Set<T>, value: T) => void;
const setDelete = uncurryThis(Set.prototype.delete) as <T>(set: Set<T>, value: T) => boolean;

// ── A secret that arrives later ────────────────────────────────────────
// Promises would hand the value to whatever `then` is current when they are
// chained or awaited, so secrets are delivered to waiting callbacks instead.

interface Slot {
  done: boolean;
  value: string | undefined;
  waiters: Array<(value: string | undefined) => void>;
}

const newSlot = (): Slot => ({ done: false, value: undefined, waiters: [] });

function settle(slot: Slot, value: string | undefined): void {
  if (slot.done) return;
  slot.done = true;
  slot.value = value;
  const waiters = slot.waiters;
  slot.waiters = [];
  for (let i = 0; i < waiters.length; i++) waiters[i](value);
}

function fill(slot: Slot, pending: Promise<string>, onError?: (err: unknown) => void): void {
  promiseThen(
    pending,
    (value) => settle(slot, typeof value === 'string' ? value : undefined),
    (err) => { onError?.(err); settle(slot, undefined); },
  );
}

function whenReady(slot: Slot, fn: (value: string | undefined) => void): void {
  if (slot.done) fn(slot.value);
  else slot.waiters[slot.waiters.length] = fn;
}

const ignore = (): undefined => undefined;

/** Call a bridge method once the token is in, as a promise for the plugin. */
function withToken<T>(slot: Slot, run: (token: string) => Promise<T>): Promise<T> {
  return new NativePromise<T>((resolve, reject) => {
    whenReady(slot, (token) => {
      if (!token) {
        reject(new Error('Plugin MCP tools are unavailable: this plugin has no MCP token'));
        return;
      }
      promiseThen(run(token), (value) => resolve(value as T), reject);
    });
  });
}

// ── State ──────────────────────────────────────────────────────────────

/**
 * The bridge methods as they were when the host claimed the issuer, before
 * any plugin code ran: plugin code that later replaces a method on
 * window.clubhouse.pluginMcp doesn't get the tokens the host passes.
 */
let bridge: Bridge | null = null;
let issuer: Slot | null = null;

interface TokenEntry {
  slot: Slot;
  contexts: Set<PluginContext>;
}

/** Live tokens, per plugin. */
const tokens = new Map<string, TokenEntry>();
/** Contexts that released their token; they never take a new one. */
const released = new WeakSet<PluginContext>();
/** Live onToolCall handlers, per plugin, across its contexts. */
const handlerCounts = new Map<string, number>();
let fallbackInstalled = false;

/** Claim this page's issuer secret. Idempotent; the first call must come before plugin code loads. */
export function claimPluginMcpIssuer(): void {
  if (issuer) return;
  const slot = newSlot();
  issuer = slot;
  try {
    bridge = { ...window.clubhouse.pluginMcp };
    fill(slot, bridge.claimIssuer(), (err) => {
      rendererLog('core:plugins', 'warn', 'Could not claim the plugin MCP issuer; plugin MCP tools are unavailable', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      });
    });
  } catch {
    settle(slot, undefined);
  }
}

/**
 * The plugin's token, issued on its first context's activation. Each context
 * holds it until that context deactivates.
 */
function acquireToken(ctx: PluginContext): Slot {
  claimPluginMcpIssuer();
  let entry = mapGet(tokens, ctx.pluginId);
  if (!entry) {
    const slot = newSlot();
    const pluginId = ctx.pluginId;
    whenReady(issuer!, (secret) => {
      if (!secret || !bridge) settle(slot, undefined);
      else fill(slot, bridge.issueToken(secret, pluginId));
    });
    // Calls are routed to this page only once it holds a token.
    whenReady(slot, (token) => { if (token) ensureFallbackResponder(); });
    entry = { slot, contexts: new Set() };
    mapSet(tokens, pluginId, entry);
  }
  if (!setHas(entry.contexts, ctx)) {
    setAdd(entry.contexts, ctx);
    const held = entry;
    ctx.subscriptions.push({
      dispose() {
        released.add(ctx);
        if (!setDelete(held.contexts, ctx) || held.contexts.size > 0) return;
        if (mapGet(tokens, ctx.pluginId) === held) mapDelete(tokens, ctx.pluginId);
        whenReady(held.slot, (token) => {
          if (token && bridge) promiseThen(bridge.revokeToken(token), ignore, ignore);
        });
      },
    });
  }
  return entry.slot;
}

/**
 * Answers, with an error, any tool call for a plugin that has no live
 * onToolCall handler. Installed once, for the renderer's lifetime.
 */
function ensureFallbackResponder(): void {
  if (fallbackInstalled || !bridge) return;
  fallbackInstalled = true;
  const b = bridge;
  b.onToolCall((data) => {
    if ((handlerCounts.get(data.pluginId) ?? 0) > 0) return;
    // No token means it was revoked, and main settled the call already.
    const entry = mapGet(tokens, data.pluginId);
    if (!entry) return;
    whenReady(entry.slot, (token) => {
      if (!token) return;
      b.sendToolResult(token, data.callId, {
        content: [{ type: 'text', text: `Plugin ${data.pluginId} has no active tool handler` }],
        isError: true,
      });
    });
  });
}

/** `api.mcp` for a context that already released its token. */
function releasedMcpAPI(): McpAPI {
  const gone = () => NativePromise.reject(new Error('Plugin MCP tools are unavailable: this plugin was deactivated'));
  return {
    contributeTools: gone,
    // Main removed the tools with the token: a plugin's deactivate() may still call this.
    removeTools: () => NativePromise.resolve(),
    listContributedTools: gone,
    onToolCall: () => ({ dispose: ignore }),
  };
}

/** Build `api.mcp` for a context of a plugin that holds `mcp.tools`. */
export function createMcpAPI(ctx: PluginContext): McpAPI {
  if (released.has(ctx)) return releasedMcpAPI();
  const slot = acquireToken(ctx);
  const b = bridge;
  if (!b) return releasedMcpAPI();
  return {
    contributeTools(tools) {
      return withToken(slot, (token) => b.contributeTools(token, tools)).then(ignore);
    },
    removeTools() {
      if (released.has(ctx)) return NativePromise.resolve();
      return withToken(slot, (token) => b.removeTools(token)).then(ignore);
    },
    listContributedTools() {
      return withToken(slot, (token) => b.listTools(token));
    },
    onToolCall(handler) {
      handlerCounts.set(ctx.pluginId, (handlerCounts.get(ctx.pluginId) ?? 0) + 1);
      const cleanup = b.onToolCall((data) => {
        if (data.pluginId !== ctx.pluginId) return;
        const reply = (result: Awaited<ReturnType<typeof handler>>) => whenReady(slot, (token) => {
          if (token) b.sendToolResult(token, data.callId, result);
        });
        const fail = (err: unknown) => reply({
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
        try {
          promiseThen(NativePromise.resolve(handler(data.toolName, data.args)), (r) => reply(r as Awaited<ReturnType<typeof handler>>), fail);
        } catch (err) {
          fail(err);
        }
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
