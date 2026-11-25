/**
 * Plugin API features removed in Clubhouse 1.0: companion agents (with the
 * `workspace` plugin kind and companion config) and MCP tool contribution
 * (`mcp.tools`). No built-in or Workshop plugin used them. A plugin that
 * still declares them loads without them: the manifest validator strips them
 * with a warning, and the API methods reject with REMOVED_FEATURE_MESSAGE.
 */
export const REMOVED_PLUGIN_PERMISSIONS = ['companion', 'mcp.tools'] as const;

/** The plugin kind that owned a companion agent and workspace. Loads as a normal plugin now. */
export const REMOVED_PLUGIN_KIND = 'workspace';

export type RemovedPluginFeature = 'companion agents' | 'MCP tools';

/** The rejection a removed plugin API method gives. */
export function removedPluginFeatureMessage(feature: RemovedPluginFeature): string {
  return `Plugin ${feature} are no longer supported. They were removed in Clubhouse 1.0.`;
}

/** The warning logged when a manifest still declares removed features. */
export function removedFeaturesWarning(declared: readonly string[]): string {
  return `This plugin declares ${declared.join(', ')}, which ${declared.length === 1 ? 'is' : 'are'} no longer supported (removed in Clubhouse 1.0) and ${declared.length === 1 ? 'is' : 'are'} ignored.`;
}
