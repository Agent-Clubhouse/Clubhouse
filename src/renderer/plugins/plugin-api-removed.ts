/**
 * Plugin API methods for features removed in Clubhouse 1.0: companion agents
 * and MCP tool contribution (`api.mcp`). They stay on the API object so plugin
 * code that calls them gets a clear rejection instead of a TypeError, and each
 * use is logged once per plugin and method.
 */
import type { Disposable, McpAPI, PluginContext } from '../../shared/plugin-types';
import { removedPluginFeatureMessage, type RemovedPluginFeature } from '../../shared/removed-plugin-features';
import { rendererLog } from './renderer-logger';

const logged = new Set<string>();

function noteRemovedUse(pluginId: string, feature: RemovedPluginFeature, method: string): string {
  const message = removedPluginFeatureMessage(feature);
  const key = `${pluginId}\u0000${method}`;
  if (!logged.has(key)) {
    logged.add(key);
    rendererLog('core:plugins', 'warn', `Plugin "${pluginId}" called ${method}: ${message}`, {
      meta: { pluginId, method },
    });
  }
  return message;
}

/** Rejects with the "no longer supported" message, and logs it once. */
export function rejectRemovedPluginFeature(pluginId: string, feature: RemovedPluginFeature, method: string): Promise<never> {
  return Promise.reject(new Error(noteRemovedUse(pluginId, feature, method)));
}

/** `api.mcp`: every method rejects; onToolCall returns a Disposable that does nothing. */
export function createRemovedMcpAPI(ctx: PluginContext): McpAPI {
  const pluginId = ctx.pluginId;
  return {
    contributeTools: () => rejectRemovedPluginFeature(pluginId, 'MCP tools', 'mcp.contributeTools'),
    removeTools: () => rejectRemovedPluginFeature(pluginId, 'MCP tools', 'mcp.removeTools'),
    listContributedTools: () => rejectRemovedPluginFeature(pluginId, 'MCP tools', 'mcp.listContributedTools'),
    onToolCall: (): Disposable => {
      noteRemovedUse(pluginId, 'MCP tools', 'mcp.onToolCall');
      return { dispose: () => {} };
    },
  };
}

export function _resetRemovedFeatureLogForTests(): void {
  logged.clear();
}
