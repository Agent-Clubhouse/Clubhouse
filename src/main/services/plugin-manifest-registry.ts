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
 *
 * Two registration paths enforce a trust boundary:
 *
 * 1. `registerTrustedManifest` / `initializeTrustedManifests` / `refreshManifest`
 *    — called by the main process when reading manifests from disk (discovery,
 *    hot-reload).  Preserves all fields including security-sensitive ones like
 *    `allowedCommands`.
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

const builtinManifestById = new Map<string, PluginManifest>([
  [hubManifest.id, hubManifest],
  [terminalManifest.id, terminalManifest],
  [filesManifest.id, filesManifest],
]);

/**
 * Security-sensitive manifest fields that are stripped from renderer-sourced
 * registrations.  These fields grant capabilities that must only come from
 * the on-disk manifest read by the main process.
 */
const SENSITIVE_FIELDS: (keyof PluginManifest)[] = ['allowedCommands'];

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
  manifestsEnabled = true;
  communityManifestsEnabled = false;
}
