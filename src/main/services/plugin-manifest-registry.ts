import * as fs from 'fs';
import * as path from 'path';
import type { PluginManifest } from '../../shared/plugin-types';
import { isValidPluginId, validateManifest } from '../../shared/manifest-validator';
import { manifest as filesManifest } from '../../renderer/plugins/builtin/files/manifest';
import { manifest as terminalManifest } from '../../renderer/plugins/builtin/terminal/manifest';
import { manifest as browserManifest } from '../../renderer/plugins/builtin/browser/manifest';
import { manifest as gitManifest } from '../../renderer/plugins/builtin/git/manifest';
import { manifest as canvasManifest } from '../../renderer/plugins/builtin/canvas/manifest';
import { manifest as reviewManifest } from '../../renderer/plugins/builtin/review/manifest';
import { manifest as stickyNoteManifest } from '../../renderer/plugins/builtin/sticky-note/manifest';
import { manifest as goobersManifest } from '../../renderer/plugins/builtin/goobers/manifest';
import { manifest as groupProjectManifest } from '../../renderer/plugins/builtin/group-project/manifest';
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
  [terminalManifest.id, terminalManifest],
  [filesManifest.id, filesManifest],
  [browserManifest.id, browserManifest],
  [gitManifest.id, gitManifest],
  [canvasManifest.id, canvasManifest],
  [groupProjectManifest.id, groupProjectManifest],
  [reviewManifest.id, reviewManifest],
  [stickyNoteManifest.id, stickyNoteManifest],
  [goobersManifest.id, goobersManifest],
]);

let manifestsEnabled = true;

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

  if (!manifestsEnabled) return;

  for (const manifest of builtinManifestById.values()) {
    registerTrustedManifest(manifest.id, manifest);
  }

  if (!readExternalPluginsEnabled()) return;

  for (const { manifest: rawManifest, pluginPath } of await discoverCommunityPlugins()) {
    const { manifest, errors } = validateTrustedManifest(rawManifest);
    if (manifest) {
      registerTrustedManifest(manifest.id, manifest);
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
    registerTrustedManifest(pluginId, builtinManifest);
    return;
  }

  if (!readExternalPluginsEnabled()) {
    trustedManifests.delete(pluginId);
    return;
  }

  const trustedCommunityManifest = await loadTrustedCommunityManifest(pluginId);
  if (!trustedCommunityManifest) {
    trustedManifests.delete(pluginId);
    return;
  }

  registerTrustedManifest(pluginId, trustedCommunityManifest);
}

/**
 * Register a manifest from a trusted source (main-process disk read).
 * Preserves all fields including security-sensitive ones.
 */
export function registerTrustedManifest(pluginId: string, manifest: PluginManifest): void {
  // All policy writes, including future callers, use the same gates. Reserved
  // host namespaces (_system and _agentconfig*) cannot be manifest IDs: the
  // shared validator's lowercase/digit/hyphen allowlist excludes them.
  if (!manifestsEnabled || (!builtinManifestById.has(pluginId) && !readExternalPluginsEnabled())) {
    trustedManifests.delete(pluginId);
    return;
  }
  const validated = validateTrustedManifest(manifest).manifest;
  if (!isValidPluginId(pluginId) || !validated || validated.id !== pluginId) {
    trustedManifests.delete(pluginId);
    appLog('core:plugins', 'warn', 'Plugin manifest registration refused');
    return;
  }
  trustedManifests.set(pluginId, validated);
}

/**
 * Get the manifest for a plugin from the trusted registry.
 */
export function getManifest(pluginId: string): PluginManifest | undefined {
  const manifest = trustedManifests.get(pluginId);
  if (!manifest || !manifestsEnabled) return undefined;
  // The external support switch can change without restarting. Read the same
  // persisted flag Settings writes, so stale registrations confer no access.
  if (!builtinManifestById.has(pluginId) && !readExternalPluginsEnabled()) return undefined;
  return manifest;
}

/**
 * Get allowed commands for a plugin.
 * Only returns commands from trusted (disk-sourced) manifests.
 */
export function getAllowedCommands(pluginId: string): string[] {
  return getManifest(pluginId)?.allowedCommands ?? [];
}

/**
 * List all registered manifests (built-in + community).
 * Used by the annex snapshot to advertise installed plugins.
 */
export function listAllManifests(): PluginManifest[] {
  return Array.from(trustedManifests.values()).filter((manifest) => getManifest(manifest.id) !== undefined);
}

export function unregisterManifest(pluginId: string): boolean {
  return trustedManifests.delete(pluginId);
}

export function clear(): void {
  trustedManifests.clear();
  manifestsEnabled = true;
}
