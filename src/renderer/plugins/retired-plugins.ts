import type { ExplorerTab } from '../../shared/types';

/**
 * Built-in plugins that have been removed from Clubhouse. Existing installs may
 * still name them in persisted state (enabled-plugin lists, the last explorer
 * tab), so that state is scrubbed on load rather than left to dangle.
 */
export const RETIRED_BUILTIN_PLUGIN_IDS: ReadonlySet<string> = new Set(['hub']);

const FALLBACK_EXPLORER_TAB: ExplorerTab = 'agents';

/**
 * Drop retired built-in plugin IDs from an enabled-plugin list. An ID is kept
 * when a plugin with that ID is currently registered (e.g. a community plugin
 * that happens to reuse the name).
 */
export function stripRetiredPluginIds(
  ids: readonly string[],
  isRegistered: (pluginId: string) => boolean = () => false,
): { ids: string[]; changed: boolean } {
  const kept = ids.filter((id) => !RETIRED_BUILTIN_PLUGIN_IDS.has(id) || isRegistered(id));
  return { ids: kept, changed: kept.length !== ids.length };
}

/** Plugin ID addressed by an explorer tab (`plugin:<id>` or `plugin:app:<id>`), if any. */
function pluginIdForTab(tab: ExplorerTab): string | null {
  if (tab.startsWith('plugin:app:')) return tab.slice('plugin:app:'.length);
  if (tab.startsWith('plugin:')) return tab.slice('plugin:'.length);
  return null;
}

/** Map a tab that points at a retired built-in plugin to the Agents tab. */
export function migrateRetiredExplorerTab(
  tab: ExplorerTab,
  isRegistered: (pluginId: string) => boolean = () => false,
): ExplorerTab {
  const pluginId = pluginIdForTab(tab);
  if (pluginId && RETIRED_BUILTIN_PLUGIN_IDS.has(pluginId) && !isRegistered(pluginId)) {
    return FALLBACK_EXPLORER_TAB;
  }
  return tab;
}
