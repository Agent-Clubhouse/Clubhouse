import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '../../shared/plugin-types';
import { validateManifest } from '../../renderer/plugins/manifest-validator';
import { manifest as filesManifest } from '../../renderer/plugins/builtin/files/manifest';
import { manifest as hubManifest } from '../../renderer/plugins/builtin/hub/manifest';
import { manifest as terminalManifest } from '../../renderer/plugins/builtin/terminal/manifest';
import { appLog } from './log-service';
import { discoverCommunityPlugins } from './plugin-discovery';
import { getGlobalPluginDataDir } from './plugin-storage';

/**
 * Server-side (main process) registry for plugin manifests.
 *
 * Security policy must be sourced from trusted main-process data only.
 * Built-in manifests are loaded from bundled sources and community manifests
 * are read and validated from disk. Renderer IPC can request a refresh by
 * plugin ID, but renderer-provided manifest payloads are never authoritative.
 */
const manifests = new Map<string, PluginManifest>();
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

function loadTrustedCommunityManifest(pluginId: string): PluginManifest | undefined {
  const discovered = discoverCommunityPlugins().find(({ manifest }) => manifest.id === pluginId);
  if (!discovered) return undefined;

  return validateTrustedManifest(discovered.manifest).manifest;
}

export function initializeTrustedManifests(): void {
  clear();
  manifestsEnabled = process.env.CLUBHOUSE_SAFE_MODE !== '1';
  communityManifestsEnabled = false;

  if (!manifestsEnabled) return;

  for (const manifest of builtinManifestById.values()) {
    manifests.set(manifest.id, manifest);
  }

  communityManifestsEnabled = readExternalPluginsEnabled();
  if (!communityManifestsEnabled) return;

  for (const { manifest: rawManifest, pluginPath } of discoverCommunityPlugins()) {
    const { manifest, errors } = validateTrustedManifest(rawManifest);
    if (manifest) {
      manifests.set(manifest.id, manifest);
      continue;
    }

    appLog('core:plugins', 'warn', 'Skipping invalid community plugin manifest for security policy', {
      meta: { pluginPath, errors },
    });
  }
}

export function refreshManifest(pluginId: string): void {
  if (!manifestsEnabled) {
    manifests.delete(pluginId);
    return;
  }

  const builtinManifest = builtinManifestById.get(pluginId);
  if (builtinManifest) {
    manifests.set(pluginId, builtinManifest);
    return;
  }

  if (!communityManifestsEnabled) {
    manifests.delete(pluginId);
    return;
  }

  const trustedCommunityManifest = loadTrustedCommunityManifest(pluginId);
  if (!trustedCommunityManifest) {
    manifests.delete(pluginId);
    return;
  }

  manifests.set(pluginId, trustedCommunityManifest);
}

export function registerTrustedManifest(pluginId: string, manifest: PluginManifest): void {
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
  manifestsEnabled = true;
  communityManifestsEnabled = false;
}
