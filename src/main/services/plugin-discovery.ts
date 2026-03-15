import * as fsp from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';
import type { PluginManifest } from '../../shared/plugin-types';
import { getGlobalPluginDataDir } from './plugin-storage';
import * as agentSettings from './agent-settings-service';
import { registerTrustedManifest } from './plugin-manifest-registry';
import { pathExists } from './fs-utils';

function getCommunityPluginsDir(): string {
  return path.join(app.getPath('home'), '.clubhouse', 'plugins');
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  pluginPath: string;
  /** True when the plugin was installed via the marketplace (has .marketplace marker). */
  fromMarketplace: boolean;
}

export async function discoverCommunityPlugins(): Promise<DiscoveredPlugin[]> {
  const pluginsDir = getCommunityPluginsDir();
  if (!await pathExists(pluginsDir)) return [];

  const results: DiscoveredPlugin[] = [];
  try {
    const dirs = await fsp.readdir(pluginsDir, { withFileTypes: true });
    for (const dir of dirs) {
      // Symlinks need stat() to check if target is a directory
      if (!dir.isDirectory()) {
        if (!dir.isSymbolicLink()) continue;
        try {
          const resolved = await fsp.stat(path.join(pluginsDir, dir.name));
          if (!resolved.isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      }
      const manifestPath = path.join(pluginsDir, dir.name, 'manifest.json');
      if (!await pathExists(manifestPath)) continue;
      try {
        const raw = await fsp.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(raw) as PluginManifest;
        const pluginDir = path.join(pluginsDir, dir.name);
        const fromMarketplace = await pathExists(path.join(pluginDir, '.marketplace'));
        // Register manifest as trusted in main-process registry.
        // This is the authoritative source for security-sensitive fields
        // like allowedCommands — the renderer cannot override these.
        if (manifest.id) {
          registerTrustedManifest(manifest.id, manifest);
        }
        results.push({
          manifest,
          pluginPath: pluginDir,
          fromMarketplace,
        });
      } catch {
        // Invalid manifest, skip
      }
    }
  } catch {
    // plugins dir doesn't exist or can't be read
  }
  return results;
}

/**
 * Re-read a plugin's manifest from disk and update the trusted registry.
 * Used during hot-reload to ensure the main process has the latest
 * security-sensitive fields without trusting the renderer.
 *
 * Returns the refreshed manifest, or null if the plugin was not found on disk.
 */
export async function refreshManifestFromDisk(pluginId: string): Promise<PluginManifest | null> {
  const pluginsDir = getCommunityPluginsDir();
  const pluginDir = path.join(pluginsDir, pluginId);
  const manifestPath = path.join(pluginDir, 'manifest.json');

  try {
    // Verify the plugin directory is actually inside the plugins directory
    // to prevent path traversal attacks.
    const resolvedDir = await fsp.realpath(pluginDir);
    const resolvedPluginsDir = await fsp.realpath(pluginsDir);
    if (!resolvedDir.startsWith(resolvedPluginsDir + path.sep) && resolvedDir !== resolvedPluginsDir) {
      return null;
    }

    const raw = await fsp.readFile(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw) as PluginManifest;
    if (manifest.id) {
      registerTrustedManifest(manifest.id, manifest);
    }
    return manifest;
  } catch {
    return null;
  }
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  const pluginDir = path.join(getCommunityPluginsDir(), pluginId);

  let stat: Awaited<ReturnType<typeof fsp.lstat>>;
  try {
    stat = await fsp.lstat(pluginDir);
  } catch {
    return; // path doesn't exist — nothing to do
  }

  if (stat.isSymbolicLink()) {
    // Remove only the symlink, not the target directory
    await fsp.unlink(pluginDir);
  } else {
    await fsp.rm(pluginDir, { recursive: true, force: true });
  }

  // Clean up the plugin's data directory (storage + files dataDir)
  const dataDir = path.join(getGlobalPluginDataDir(), pluginId);
  try {
    await fsp.rm(dataDir, { recursive: true, force: true });
  } catch {
    // Best-effort — data dir may not exist
  }
}

/** What a plugin has injected into a specific project. */
export interface ProjectPluginInjections {
  /** Source skill names (without the `plugin-{id}-` prefix) */
  skills: string[];
  /** Source agent template names (without the `plugin-{id}-` prefix) */
  agentTemplates: string[];
  /** Whether the plugin has an instruction block in project agent defaults */
  hasInstructions: boolean;
  /** Number of allow-permission rules from this plugin */
  permissionAllowCount: number;
  /** Number of deny-permission rules from this plugin */
  permissionDenyCount: number;
  /** MCP server names added by this plugin (without `plugin-{id}-` prefix) */
  mcpServerNames: string[];
}

/**
 * Returns all injections a plugin has made into a given project.
 * Scans skills, agent templates, and project agent defaults.
 */
export async function listProjectPluginInjections(pluginId: string, projectPath: string): Promise<ProjectPluginInjections> {
  const prefix = `plugin-${pluginId}-`;
  const tag = `/* plugin:${pluginId} */`;

  const allSkills = await agentSettings.listSourceSkills(projectPath);
  const skills = allSkills
    .filter((s) => s.name.startsWith(prefix))
    .map((s) => s.name.slice(prefix.length));

  const allTemplates = await agentSettings.listSourceAgentTemplates(projectPath);
  const agentTemplates = allTemplates
    .filter((t) => t.name.startsWith(prefix))
    .map((t) => t.name.slice(prefix.length));

  const defaults = await agentSettings.readProjectAgentDefaults(projectPath);

  const hasInstructions = !!(defaults.instructions &&
    defaults.instructions.includes(`<!-- plugin:${pluginId}:start -->`));

  const permissionAllowCount = (defaults.permissions?.allow || []).filter((r) => r.includes(tag)).length;
  const permissionDenyCount = (defaults.permissions?.deny || []).filter((r) => r.includes(tag)).length;

  let mcpServerNames: string[] = [];
  if (defaults.mcpJson) {
    try {
      const mcpConfig = JSON.parse(defaults.mcpJson);
      const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};
      mcpServerNames = Object.keys(mcpServers)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    } catch { /* ignore invalid JSON */ }
  }

  return { skills, agentTemplates, hasInstructions, permissionAllowCount, permissionDenyCount, mcpServerNames };
}

/**
 * Removes all injections a plugin has made into a given project:
 * - Deletes source skills prefixed with `plugin-{pluginId}-`
 * - Deletes source agent templates prefixed with `plugin-{pluginId}-`
 * - Strips instruction block from project agent defaults
 * - Removes permission rules tagged with the plugin's comment tag
 * - Removes MCP servers prefixed with `plugin-{pluginId}-`
 * - Deletes the `_agentconfig:{pluginId}` storage directory in the project
 */
export async function cleanupProjectPluginInjections(pluginId: string, projectPath: string): Promise<void> {
  const prefix = `plugin-${pluginId}-`;
  const tag = `/* plugin:${pluginId} */`;

  // 1. Delete injected source skills
  try {
    const skills = await agentSettings.listSourceSkills(projectPath);
    for (const skill of skills) {
      if (skill.name.startsWith(prefix)) {
        await agentSettings.deleteSourceSkill(projectPath, skill.name);
      }
    }
  } catch { /* Best-effort */ }

  // 2. Delete injected source agent templates
  try {
    const templates = await agentSettings.listSourceAgentTemplates(projectPath);
    for (const template of templates) {
      if (template.name.startsWith(prefix)) {
        await agentSettings.deleteSourceAgentTemplate(projectPath, template.name);
      }
    }
  } catch { /* Best-effort */ }

  // 3. Strip instructions / permissions / MCP servers from project agent defaults
  try {
    const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
    let dirty = false;
    const updated = { ...defaults };

    // Remove instruction block
    if (defaults.instructions) {
      const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(
        `\\n?\\n?<!-- plugin:${escaped}:start -->[\\s\\S]*?<!-- plugin:${escaped}:end -->`,
      );
      const cleaned = defaults.instructions.replace(regex, '');
      if (cleaned !== defaults.instructions) {
        updated.instructions = cleaned;
        dirty = true;
      }
    }

    // Remove tagged permission rules
    if (defaults.permissions) {
      const allow = (defaults.permissions.allow || []).filter((r) => !r.includes(tag));
      const deny = (defaults.permissions.deny || []).filter((r) => !r.includes(tag));
      if (allow.length !== (defaults.permissions.allow || []).length ||
          deny.length !== (defaults.permissions.deny || []).length) {
        updated.permissions = { allow, deny };
        dirty = true;
      }
    }

    // Remove MCP servers added by this plugin
    if (defaults.mcpJson) {
      try {
        const mcpConfig = JSON.parse(defaults.mcpJson) as Record<string, unknown>;
        const mcpServers = (mcpConfig.mcpServers as Record<string, unknown>) || {};
        const cleaned = Object.fromEntries(
          Object.entries(mcpServers).filter(([k]) => !k.startsWith(prefix)),
        );
        if (Object.keys(cleaned).length !== Object.keys(mcpServers).length) {
          updated.mcpJson = JSON.stringify({ ...mcpConfig, mcpServers: cleaned }, null, 2);
          dirty = true;
        }
      } catch { /* ignore invalid JSON */ }
    }

    if (dirty) {
      await agentSettings.writeProjectAgentDefaults(projectPath, updated);
    }
  } catch { /* Best-effort */ }

  // 4. Delete the _agentconfig storage directory for this plugin in the project
  const agentConfigDataDir = path.join(projectPath, '.clubhouse', 'plugin-data', `_agentconfig:${pluginId}`);
  try {
    await fsp.rm(agentConfigDataDir, { recursive: true, force: true });
  } catch { /* Best-effort — directory may not exist */ }
}

/**
 * Returns IDs of plugins that have injections in a project but are not in the list of
 * known/installed plugin IDs. These are "orphaned" injections left by uninstalled plugins.
 *
 * Checks:
 * - `_agentconfig:{id}` storage directories under `.clubhouse/plugin-data/`
 * - HTML comment markers in project agent default instructions
 * - Permission rule comments tagged with the plugin's comment tag
 */
export async function listOrphanedPluginIds(projectPath: string, knownPluginIds: string[]): Promise<string[]> {
  const orphans = new Set<string>();
  const known = new Set(knownPluginIds);

  // Check _agentconfig:xxx storage directories — these track injection metadata
  const pluginDataDir = path.join(projectPath, '.clubhouse', 'plugin-data');
  try {
    const entries = await fsp.readdir(pluginDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith('_agentconfig:')) {
        const pluginId = entry.name.slice('_agentconfig:'.length);
        if (!known.has(pluginId)) {
          orphans.add(pluginId);
        }
      }
    }
  } catch { /* directory may not exist */ }

  // Check instruction markers
  try {
    const defaults = await agentSettings.readProjectAgentDefaults(projectPath);
    if (defaults.instructions) {
      const matches = defaults.instructions.matchAll(/<!-- plugin:([^:]+):start -->/g);
      for (const match of matches) {
        const pluginId = match[1];
        if (!known.has(pluginId)) orphans.add(pluginId);
      }
    }

    // Check permission rule comments
    const allRules = [
      ...(defaults.permissions?.allow || []),
      ...(defaults.permissions?.deny || []),
    ];
    for (const rule of allRules) {
      const permMatch = rule.match(/\/\* plugin:([^ ]+) \*\//);
      if (permMatch) {
        const pluginId = permMatch[1];
        if (!known.has(pluginId)) orphans.add(pluginId);
      }
    }
  } catch { /* Best-effort */ }

  return Array.from(orphans);
}
