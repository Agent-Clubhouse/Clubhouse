/**
 * Plugin MCP capability tokens: bind each plugin-mcp call to the plugin
 * that made it.
 *
 * Every plugin runs in the same renderer and sees the same window.clubhouse,
 * so a pluginId passed as an argument proves nothing. Instead:
 *
 * 1. Once per page load, the renderer's plugin host claims an issuer secret
 *    (plugin-loader does this before any plugin code is loaded). A second
 *    claim from the same page is refused, so plugin code can't get one.
 * 2. With that secret the host gets one token per plugin it activates, and
 *    keeps it in a closure: plugins never see it, on window.clubhouse or
 *    anywhere else.
 * 3. Main resolves the pluginId from the token on every plugin-mcp call and
 *    never trusts a pluginId from the arguments.
 *
 * Tokens are revoked when the host deactivates the plugin, on uninstall, and
 * when the page that holds them navigates or is destroyed.
 */

import { randomUUID } from 'crypto';
import { getManifest } from '../plugin-manifest-registry';

export interface PluginTokenOwner {
  pluginId: string;
  webContentsId: number;
}

/** Issuer secret per renderer page, keyed by webContents id. */
const issuers = new Map<number, string>();
/** token -> owner */
const tokens = new Map<string, PluginTokenOwner>();

type RevokeListener = (pluginId: string, remainingForPlugin: number) => void;
const revokeListeners = new Set<RevokeListener>();

/**
 * Called after tokens are revoked, once per affected plugin, with how many
 * live tokens that plugin still has (in any window).
 */
export function onPluginTokensRevoked(listener: RevokeListener): () => void {
  revokeListeners.add(listener);
  return () => { revokeListeners.delete(listener); };
}

function liveTokenCount(pluginId: string): number {
  let n = 0;
  for (const owner of tokens.values()) if (owner.pluginId === pluginId) n++;
  return n;
}

function notifyRevoked(pluginIds: Iterable<string>): void {
  for (const pluginId of new Set(pluginIds)) {
    const remaining = liveTokenCount(pluginId);
    for (const listener of revokeListeners) listener(pluginId, remaining);
  }
}

/** True if the plugin's trusted manifest grants `mcp.tools`. */
export function hasMcpToolsPermission(pluginId: string): boolean {
  return !!getManifest(pluginId)?.permissions?.includes('mcp.tools');
}

/** Claim the issuer secret for a page. Throws if that page already claimed it. */
export function claimIssuer(webContentsId: number): string {
  if (issuers.has(webContentsId)) {
    throw new Error('Plugin MCP issuer already claimed for this window');
  }
  const secret = randomUUID();
  issuers.set(webContentsId, secret);
  return secret;
}

/**
 * Issue a token for a plugin. Requires the page's issuer secret, a trusted
 * manifest for the plugin, and the `mcp.tools` permission in it.
 */
export function issueToken(webContentsId: number, issuerSecret: string, pluginId: string): string {
  const expected = issuers.get(webContentsId);
  if (!expected || expected !== issuerSecret) {
    throw new Error('Plugin MCP token request rejected: not the plugin host');
  }
  if (!hasMcpToolsPermission(pluginId)) {
    throw new Error(`Plugin '${pluginId}' requires 'mcp.tools' permission to use MCP tools`);
  }
  const token = randomUUID();
  tokens.set(token, { pluginId, webContentsId });
  return token;
}

/** The owner of a live token, or undefined. */
export function resolveToken(token: unknown): PluginTokenOwner | undefined {
  return typeof token === 'string' ? tokens.get(token) : undefined;
}

/**
 * The plugin a call comes from: the token must be live, belong to the
 * calling page, and its plugin must still hold `mcp.tools`. Throws otherwise.
 */
export function requirePluginForToken(token: unknown, webContentsId: number): string {
  const owner = resolveToken(token);
  if (!owner || owner.webContentsId !== webContentsId) {
    throw new Error('Plugin MCP call rejected: unknown or revoked token');
  }
  if (!hasMcpToolsPermission(owner.pluginId)) {
    throw new Error(`Plugin '${owner.pluginId}' requires 'mcp.tools' permission to use MCP tools`);
  }
  return owner.pluginId;
}

/** Revoke one token held by a page. Returns its plugin, if it was live. */
export function revokeToken(token: string, webContentsId: number): string | undefined {
  const owner = tokens.get(token);
  if (!owner || owner.webContentsId !== webContentsId) return undefined;
  tokens.delete(token);
  notifyRevoked([owner.pluginId]);
  return owner.pluginId;
}

/** Revoke every token of a plugin, in every window (uninstall). */
export function revokePluginTokens(pluginId: string): void {
  let any = false;
  for (const [token, owner] of tokens) {
    if (owner.pluginId === pluginId) {
      tokens.delete(token);
      any = true;
    }
  }
  if (any) notifyRevoked([pluginId]);
}

/**
 * Forget a page: its issuer and every token it holds. Called when the page
 * navigates or its webContents is destroyed, so a reloaded page can claim a
 * fresh issuer.
 */
export function revokeWebContents(webContentsId: number): void {
  issuers.delete(webContentsId);
  const affected: string[] = [];
  for (const [token, owner] of tokens) {
    if (owner.webContentsId === webContentsId) {
      tokens.delete(token);
      affected.push(owner.pluginId);
    }
  }
  notifyRevoked(affected);
}

/** The page holding the newest live token for a plugin, if any. */
export function webContentsIdForPlugin(pluginId: string): number | undefined {
  let found: number | undefined;
  for (const owner of tokens.values()) if (owner.pluginId === pluginId) found = owner.webContentsId;
  return found;
}

/** For testing. */
export function _resetForTesting(): void {
  issuers.clear();
  tokens.clear();
  revokeListeners.clear();
}
