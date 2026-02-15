import type { PluginModule } from '../../../shared/plugin-types';
import { validateManifest } from '../manifest-validator';
import type { BuiltinPlugin } from './index';

interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a single built-in plugin: manifest validity, module shape.
 */
export function validateBuiltinPlugin(plugin: BuiltinPlugin): ValidationResult {
  const errors: string[] = [];

  // Validate manifest
  const manifestResult = validateManifest(plugin.manifest);
  if (!manifestResult.valid) {
    errors.push(...manifestResult.errors);
  }

  // Check that module exports activate() or at least one Panel component
  const mod = plugin.module;
  const hasActivate = typeof mod.activate === 'function';
  const hasPanel =
    mod.MainPanel !== undefined ||
    mod.SidebarPanel !== undefined ||
    mod.HubPanel !== undefined ||
    mod.SettingsPanel !== undefined;

  if (!hasActivate && !hasPanel) {
    errors.push('Plugin module must export activate() or at least one Panel component');
  }

  // If deactivate is present, it must be a function
  if ('deactivate' in mod && mod.deactivate !== undefined && typeof mod.deactivate !== 'function') {
    errors.push('deactivate must be a function if provided');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates all built-in plugins: individual validity + duplicate ID check.
 */
export function validateAllBuiltinPlugins(plugins: BuiltinPlugin[]): ValidationResult {
  const errors: string[] = [];

  // Check for duplicate IDs
  const ids = new Set<string>();
  for (const plugin of plugins) {
    if (ids.has(plugin.manifest.id)) {
      errors.push(`Duplicate built-in plugin ID: "${plugin.manifest.id}"`);
    }
    ids.add(plugin.manifest.id);
  }

  // Validate each plugin
  for (const plugin of plugins) {
    const result = validateBuiltinPlugin(plugin);
    if (!result.valid) {
      errors.push(...result.errors.map((e) => `[${plugin.manifest.id}] ${e}`));
    }
  }

  return { valid: errors.length === 0, errors };
}
