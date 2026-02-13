import * as fs from 'fs';
import * as path from 'path';
import { ConfigLayer, ConfigItemKey, ProjectSettings, DurableAgentConfig } from '../../shared/types';
import {
  DURABLE_CLAUDE_MD_TEMPLATE,
  QUICK_CLAUDE_MD_TEMPLATE,
  DEFAULT_DURABLE_PERMISSIONS,
  DEFAULT_QUICK_PERMISSIONS,
} from '../../shared/agent-templates';

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

/** Built-in defaults for durable agents — used when no settings.json exists. */
const BUILT_IN_DURABLE_DEFAULTS: ConfigLayer = {
  claudeMd: DURABLE_CLAUDE_MD_TEMPLATE,
  permissions: { allow: DEFAULT_DURABLE_PERMISSIONS },
};

/** Built-in defaults for quick agents. */
const BUILT_IN_QUICK_DEFAULTS: ConfigLayer = {
  claudeMd: QUICK_CLAUDE_MD_TEMPLATE,
  permissions: { allow: DEFAULT_QUICK_PERMISSIONS },
};

/**
 * Reads settings.json + settings.local.json, merges into effective project defaults.
 * Chain: built-in → settings.json → settings.local.json
 * If settings.json sets a key to null, the built-in is explicitly cleared.
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

  const userDefaults: ConfigLayer = settings.defaults || {};

  // Layer: built-in → user settings.json defaults
  let result = mergeConfigLayers(BUILT_IN_DURABLE_DEFAULTS, userDefaults);

  let localLayer: ConfigLayer = {};
  try {
    localLayer = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch {
    // No local file
  }

  // Layer: → settings.local.json
  return mergeConfigLayers(result, localLayer);
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
 * Chain: built-in quick defaults → project defaults → local settings → project quickOverrides → parent durable quickConfigLayer
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

  // Start with built-in quick defaults → user defaults
  const userDefaults: ConfigLayer = settings.defaults || {};
  let result = mergeConfigLayers(BUILT_IN_QUICK_DEFAULTS, userDefaults);

  let localLayer: ConfigLayer = {};
  try {
    localLayer = JSON.parse(fs.readFileSync(localPath, 'utf-8'));
  } catch {
    // No local file
  }

  result = mergeConfigLayers(result, localLayer);

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
