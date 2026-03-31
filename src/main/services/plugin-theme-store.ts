/**
 * Main-process store for plugin-contributed themes.
 *
 * The theme registry lives in the renderer process, so plugin-contributed
 * themes registered there are invisible to MCP tools running in main.
 * This store receives synced theme summaries from the renderer via IPC
 * so the assistant's `list_themes` tool can surface them.
 *
 * This is the first instance of a general pattern: the renderer pushes
 * plugin contributions to main so MCP tools can enumerate them.
 */

export interface PluginThemeSummary {
  id: string;
  name: string;
  type: 'dark' | 'light';
}

let pluginThemes: PluginThemeSummary[] = [];
const listeners = new Set<() => void>();

/** Replace the full set of plugin-contributed themes. Called from IPC handler. */
export function syncPluginThemes(themes: PluginThemeSummary[]): void {
  pluginThemes = themes;
  for (const listener of listeners) {
    listener();
  }
}

/** Get the current list of plugin-contributed theme summaries. */
export function getPluginThemes(): PluginThemeSummary[] {
  return pluginThemes;
}

/** Subscribe to changes. Returns a dispose function. */
export function onPluginThemesChange(callback: () => void): { dispose: () => void } {
  listeners.add(callback);
  return { dispose: () => listeners.delete(callback) };
}

/** Reset store state — useful for testing. */
export function _reset(): void {
  pluginThemes = [];
  listeners.clear();
}
