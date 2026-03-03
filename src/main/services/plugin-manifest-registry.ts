import type { PluginManifest } from '../../shared/plugin-types';

/**
 * Server-side (main process) registry for plugin manifests.
 *
 * The renderer registers each plugin's manifest here when it loads.
 * Process-execution handlers look up allowed commands from this registry
 * instead of trusting renderer-supplied values — closing the
 * renderer-forged-policy attack vector.
 */
const manifests = new Map<string, PluginManifest>();

export function registerManifest(pluginId: string, manifest: PluginManifest): void {
  manifests.set(pluginId, manifest);
}

export function getManifest(pluginId: string): PluginManifest | undefined {
  return manifests.get(pluginId);
}

export function getAllowedCommands(pluginId: string): string[] {
  return manifests.get(pluginId)?.allowedCommands ?? [];
}

export function unregisterManifest(pluginId: string): boolean {
  return manifests.delete(pluginId);
}

export function clear(): void {
  manifests.clear();
}
