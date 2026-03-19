import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '../../shared/plugin-types';
import { validateManifest } from '../../shared/manifest-validator';
import { manifest as filesManifest } from '../../renderer/plugins/builtin/files/manifest';
import { manifest as hubManifest } from '../../renderer/plugins/builtin/hub/manifest';
import { manifest as terminalManifest } from '../../renderer/plugins/builtin/terminal/manifest';
import { appLog } from './log-service';
import { discoverCommunityPlugins } from './plugin-discovery';
import { getGlobalPluginDataDir } from './plugin-storage';

/**
 * Server-side (main process) registry for plugin manifests.
 *
 * Security policy is sourced exclusively from trusted main-process data.
 * Built-in manifests are loaded from bundled sources and community manifests
 * are read and validated from disk at startup. The renderer may request a
 * refresh by plugin ID via IPC, but never supplies manifest data — the main
 * process always re-reads from disk.
 *
 * Only one registration path exists:
 *
 * `registerTrustedManifest` / `initializeTrustedManifests` / `refreshManifest`
 * — called by the main process when reading manifests from disk (discovery,
 * hot-reload).  Preserves all fields including security-sensitive ones like
 * `allowedCommands`.
 *
 * The renderer has no path to inject or alter security policy.
 */

/** Manifests registered from a trusted source (disk reads in main process). */
const trustedManifests = new Map<string, PluginManifest>();

const builtinManifestById = new Map<string, PluginManifest>([
  [hubManifest.id, hubManifest],
  [terminalManifest.id, terminalManifest],
  [filesManifest.id, filesManifest],
]);

let manifestsEnabled = true;
let communityManifestsEnabled = false;

function readExternalPluginsEnabled(): boolean {
  const externalPluginsFlagPath = path.join(
    getGlobalPluginDataDir(),
    '_system',
    'kv',
    'external-plugins-enabled.json',
  );

  try {
    return JSON.parse(fs.readFileSync(externalPluginsFlagPath, 'utf-8')) === true;
  } catch {
    return false;
  }
}

function validateTrustedManifest(rawManifest: unknown): {
  manifest: PluginManifest | undefined;
  errors: string[];
} {
  const result = validateManifest(rawManifest);
  if (!result.valid || !result.manifest) {
    return {
      manifest: undefined,
      errors: result.errors,
    };
  }
  return {
    manifest: result.manifest,
    errors: [],
  };
}

async function loadTrustedCommunityManifest(pluginId: string): Promise<PluginManifest | undefined> {
  const discovered = (await discoverCommunityPlugins()).find(({ manifest }) => manifest.id === pluginId);
  if (!discovered) return undefined;

  return validateTrustedManifest(discovered.manifest).manifest;
}

export async function initializeTrustedManifests(): Promise<void> {
  clear();
  manifestsEnabled = process.env.CLUBHOUSE_SAFE_MODE !== '1';
  communityManifestsEnabled = false;

  if (!manifestsEnabled) return;

  for (const manifest of builtinManifestById.values()) {
    trustedManifests.set(manifest.id, manifest);
  }

  communityManifestsEnabled = readExternalPluginsEnabled();
  if (!communityManifestsEnabled) return;

  for (const { manifest: rawManifest, pluginPath } of await discoverCommunityPlugins()) {
    const { manifest, errors } = validateTrustedManifest(rawManifest);
    if (manifest) {
      trustedManifests.set(manifest.id, manifest);
      continue;
    }

    appLog('core:plugins', 'warn', 'Skipping invalid community plugin manifest for security policy', {
      meta: { pluginPath, errors },
    });
  }
}

export async function refreshManifest(pluginId: string): Promise<void> {
  if (!manifestsEnabled) {
    trustedManifests.delete(pluginId);
    return;
  }

  const builtinManifest = builtinManifestById.get(pluginId);
  if (builtinManifest) {
    trustedManifests.set(pluginId, builtinManifest);
    return;
  }

  if (!communityManifestsEnabled) {
    trustedManifests.delete(pluginId);
    return;
  }

  const trustedCommunityManifest = await loadTrustedCommunityManifest(pluginId);
  if (!trustedCommunityManifest) {
    trustedManifests.delete(pluginId);
    return;
  }

  trustedManifests.set(pluginId, trustedCommunityManifest);
}

/**
 * Register a manifest from a trusted source (main-process disk read).
 * Preserves all fields including security-sensitive ones.
 */
export function registerTrustedManifest(pluginId: string, manifest: PluginManifest): void {
  trustedManifests.set(pluginId, manifest);
}

/**
 * Get the manifest for a plugin from the trusted registry.
 */
export function getManifest(pluginId: string): PluginManifest | undefined {
  return trustedManifests.get(pluginId);
}

/**
 * Get allowed commands for a plugin.
 * Only returns commands from trusted (disk-sourced) manifests.
 */
export function getAllowedCommands(pluginId: string): string[] {
  return trustedManifests.get(pluginId)?.allowedCommands ?? [];
}

/**
 * List all registered manifests (built-in + community).
 * Used by the annex snapshot to advertise installed plugins.
 */
export function listAllManifests(): PluginManifest[] {
  return Array.from(trustedManifests.values());
}

export function unregisterManifest(pluginId: string): boolean {
  return trustedManifests.delete(pluginId);
}

export function clear(): void {
  trustedManifests.clear();
  manifestsEnabled = true;
  communityManifestsEnabled = false;
}
