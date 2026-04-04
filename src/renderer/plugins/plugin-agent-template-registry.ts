// ── Plugin Agent Template Registry ──────────────────────────────────────
// Central registry for plugin-contributed agent templates.
// Plugins call registerAgentTemplate() at activation time; the agent
// template gallery consumes the registry to discover and display
// plugin-provided templates alongside built-in filesystem templates.

import type { Disposable } from '../../shared/plugin-types';

// ── Types ──────────────────────────────────────────────────────────────

/** A plugin-contributed agent template registration (v0.9+). */
export interface PluginAgentTemplate {
  /** Template name (display name). */
  name: string;
  /** Short description of what this template creates. */
  description?: string;
  /** SVG icon string (rendered inline). */
  icon?: string;
  /** Markdown content for the agent's prompt/instructions file. */
  promptContent: string;
  /** Skills to inject — mapping of skill name to markdown content. */
  skills?: Record<string, string>;
  /** MCP server configurations to inject. */
  mcpServers?: Record<string, unknown>;
}

/** A registered template with its source plugin ID. */
export interface RegisteredPluginAgentTemplate {
  pluginId: string;
  pluginName: string;
  template: PluginAgentTemplate;
}

type RegistryListener = () => void;

// ── Registry singleton ────────────────────────────────────────────────

const registry: RegisteredPluginAgentTemplate[] = [];
const listeners = new Set<RegistryListener>();

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // swallow — a failing listener should not break others
    }
  }
}

/**
 * Register a plugin-contributed agent template.
 * @returns Disposable that unregisters the template.
 */
export function registerPluginAgentTemplate(
  pluginId: string,
  pluginName: string,
  template: PluginAgentTemplate,
): Disposable {
  const entry: RegisteredPluginAgentTemplate = { pluginId, pluginName, template };
  registry.push(entry);
  notifyListeners();
  return {
    dispose: () => {
      const idx = registry.indexOf(entry);
      if (idx !== -1) {
        registry.splice(idx, 1);
        notifyListeners();
      }
    },
  };
}

/** Unregister all templates contributed by a specific plugin. */
export function unregisterAllTemplatesForPlugin(pluginId: string): void {
  let changed = false;
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i].pluginId === pluginId) {
      registry.splice(i, 1);
      changed = true;
    }
  }
  if (changed) notifyListeners();
}

/** Get all registered plugin agent templates. */
export function getPluginAgentTemplates(): RegisteredPluginAgentTemplate[] {
  return [...registry];
}

/** Get plugin agent templates grouped by plugin ID. */
export function getPluginAgentTemplatesByPlugin(): Map<string, RegisteredPluginAgentTemplate[]> {
  const grouped = new Map<string, RegisteredPluginAgentTemplate[]>();
  for (const entry of registry) {
    const list = grouped.get(entry.pluginId) || [];
    list.push(entry);
    grouped.set(entry.pluginId, list);
  }
  return grouped;
}

/** Subscribe to registry changes. Returns a Disposable. */
export function onTemplateRegistryChange(listener: RegistryListener): Disposable {
  listeners.add(listener);
  return {
    dispose: () => { listeners.delete(listener); },
  };
}

/** Reset the registry (for testing). */
export function _resetTemplateRegistryForTesting(): void {
  registry.length = 0;
  listeners.clear();
}
