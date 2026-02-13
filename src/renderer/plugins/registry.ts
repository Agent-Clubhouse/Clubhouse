import { PluginDefinition } from './types';

const plugins = new Map<string, PluginDefinition>();

export function registerPlugin(plugin: PluginDefinition): void {
  if (plugins.has(plugin.id)) {
    console.warn(`Plugin "${plugin.id}" is already registered. Skipping duplicate.`);
    return;
  }
  plugins.set(plugin.id, plugin);
}

export function getPlugin(id: string): PluginDefinition | undefined {
  return plugins.get(id);
}

export function getAllPlugins(): PluginDefinition[] {
  return Array.from(plugins.values());
}

export function getPluginIds(): string[] {
  return Array.from(plugins.keys());
}

/** For testing only — clears all registered plugins. */
export function clearPlugins(): void {
  plugins.clear();
}
