import type { PluginManifest } from '../../shared/plugin-types';

/**
 * Server-side (main process) registry for plugin manifests.
 *
 * Two registration paths enforce a trust boundary:
 *
 * 1. `registerTrustedManifest` — called by the main process when reading
 *    manifests from disk (discovery, hot-reload).  Preserves all fields
 *    including security-sensitive ones like `allowedCommands`.
 *
 * 2. `registerManifest` — called via IPC from the renderer.  Strips
 *    security-sensitive fields so renderer/plugin code cannot self-escalate
 *    (e.g., inject `allowedCommands` to gain arbitrary command execution).
 *
 * `getAllowedCommands` only returns commands that were set through the
 * trusted path, closing the renderer-forged-policy attack vector.
 */

/** Manifests registered from a trusted source (disk reads in main process). */
const trustedManifests = new Map<string, PluginManifest>();

/** Manifests registered from the renderer (stripped of sensitive fields). */
const untrustedManifests = new Map<string, PluginManifest>();

/**
 * Security-sensitive manifest fields that are stripped from renderer-sourced
 * registrations.  These fields grant capabilities that must only come from
 * the on-disk manifest read by the main process.
 */
const SENSITIVE_FIELDS: (keyof PluginManifest)[] = ['allowedCommands'];

/**
 * Register a manifest from a trusted source (main-process disk read).
 * Preserves all fields including security-sensitive ones.
 */
export function registerTrustedManifest(pluginId: string, manifest: PluginManifest): void {
  trustedManifests.set(pluginId, manifest);
}

/**
 * Register a manifest from an untrusted source (renderer IPC).
 * Strips security-sensitive fields to prevent self-escalation.
 */
export function registerManifest(pluginId: string, manifest: PluginManifest): void {
  const sanitized = { ...manifest };
  for (const field of SENSITIVE_FIELDS) {
    delete sanitized[field];
  }
  untrustedManifests.set(pluginId, sanitized);
}

/**
 * Get the manifest for a plugin.  Prefers the trusted manifest if available.
 */
export function getManifest(pluginId: string): PluginManifest | undefined {
  return trustedManifests.get(pluginId) ?? untrustedManifests.get(pluginId);
}

/**
 * Get allowed commands for a plugin.
 * ONLY returns commands from trusted (disk-sourced) manifests.
 */
export function getAllowedCommands(pluginId: string): string[] {
  return trustedManifests.get(pluginId)?.allowedCommands ?? [];
}

export function unregisterManifest(pluginId: string): boolean {
  const a = trustedManifests.delete(pluginId);
  const b = untrustedManifests.delete(pluginId);
  return a || b;
}

export function clear(): void {
  trustedManifests.clear();
  untrustedManifests.clear();
}
