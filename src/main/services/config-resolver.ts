import * as fs from 'fs';
import * as path from 'path';
import { ConfigLayer, ConfigItemKey, ProjectSettings, DurableAgentConfig } from '../../shared/types';

/**
 * Per-key merge: overlay wins if present, null = cleared, undefined = inherit.
 */
export function mergeConfigLayers(base: ConfigLayer, overlay: ConfigLayer): ConfigLayer {
  const result: ConfigLayer = { ...base };

  for (const key of ['claudeMd', 'permissions', 'mcpConfig'] as const) {
    if (key in overlay) {
      (result as Record<string, unknown>)[key] = overlay[key];
    }
  }

  return result;
}

/**
 * Reads settings.json + settings.local.json, merges into effective project defaults.
 */
export function resolveProjectDefaults(projectPath: string): ConfigLayer {
  const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
  const localPath = path.join(projectPath, '.clubhouse', 'settings.local.json');

  let settings: ProjectSettings = { defaults: {}, quickOverrides: {} };
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No settings file
  }

  const base: ConfigLayer = settings.defaults || {};

  let localLayer: ConfigLayer = {};
  try {
    localLayer = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch {
    // No local file
  }

  return mergeConfigLayers(base, localLayer);
}

/**
 * Returns config values that should be applied to a durable agent
 * (only non-overridden items from project defaults).
 */
export function resolveDurableConfig(projectPath: string, agentId: string): ConfigLayer {
  const agentsPath = path.join(projectPath, '.clubhouse', 'agents.json');
  let agents: DurableAgentConfig[] = [];
  try {
    agents = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
  } catch {
    return {};
  }

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return {};

  const defaults = resolveProjectDefaults(projectPath);
  const overrides = agent.overrides || defaultOverrideFlags();
  const result: ConfigLayer = {};

  for (const key of ['claudeMd', 'permissions', 'mcpConfig'] as const) {
    if (!overrides[key]) {
      (result as Record<string, unknown>)[key] = (defaults as Record<string, unknown>)[key];
    }
  }

  return result;
}

/**
 * Full resolution chain for quick agents. Returns ConfigLayer with claudeMd resolved.
 *
 * Chain: project defaults → project quickOverrides → parent durable quickConfigLayer
 */
export function resolveQuickConfig(projectPath: string, parentAgentId?: string): ConfigLayer {
  const settingsPath = path.join(projectPath, '.clubhouse', 'settings.json');
  const localPath = path.join(projectPath, '.clubhouse', 'settings.local.json');

  let settings: ProjectSettings = { defaults: {}, quickOverrides: {} };
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch {
    // No settings file
  }

  // Start with effective project defaults
  const base: ConfigLayer = settings.defaults || {};
  let localLayer: ConfigLayer = {};
  try {
    localLayer = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch {
    // No local file
  }

  let result = mergeConfigLayers(base, localLayer);

  // Apply project-level quick overrides
  if (settings.quickOverrides) {
    result = mergeConfigLayers(result, settings.quickOverrides);
  }

  // Apply parent durable's quick config layer
  if (parentAgentId) {
    const agentsPath = path.join(projectPath, '.clubhouse', 'agents.json');
    try {
      const agents: DurableAgentConfig[] = JSON.parse(fs.readFileSync(agentsPath, 'utf-8'));
      const parent = agents.find((a) => a.id === parentAgentId);
      if (parent) {
        const parentQuickOverrides = parent.quickOverrides || defaultOverrideFlags();
        const parentQuickLayer = parent.quickConfigLayer || {};

        // Only apply items where parent has quickOverrides enabled
        const parentApplied: ConfigLayer = {};
        for (const key of ['claudeMd', 'permissions', 'mcpConfig'] as const) {
          if (parentQuickOverrides[key as ConfigItemKey] && key in parentQuickLayer) {
            (parentApplied as Record<string, unknown>)[key] = (parentQuickLayer as Record<string, unknown>)[key];
          }
        }

        result = mergeConfigLayers(result, parentApplied);
      }
    } catch {
      // No agents file
    }
  }

  return result;
}

/**
 * Returns which keys changed between two config layers.
 */
export function diffConfigLayers(oldLayer: ConfigLayer, newLayer: ConfigLayer): ConfigItemKey[] {
  const changed: ConfigItemKey[] = [];

  for (const key of ['claudeMd', 'permissions', 'mcpConfig'] as const) {
    const oldVal = (oldLayer as Record<string, unknown>)[key];
    const newVal = (newLayer as Record<string, unknown>)[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      changed.push(key);
    }
  }

  return changed;
}

export function defaultOverrideFlags() {
  return {
    claudeMd: false,
    permissions: false,
    mcpConfig: false,
    skills: false,
    agents: false,
  };
}
