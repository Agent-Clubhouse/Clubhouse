import type { ExplorerTab } from '../../shared/types';
import { RETIRED_PLUGINS, isRetiredPlugin } from '../../shared/retired-plugins';

/**
 * Plugins that have been removed from Clubhouse: the retired built-ins and the
 * retired Workshop plugins. Existing installs may still name them in persisted
 * state (enabled-plugin lists, the last explorer tab), so that state is
 * scrubbed on load rather than left to dangle. Keep in sync with
 * RETIRED_BUILTIN_PLUGIN_IDS and RETIRED_WORKSHOP_PLUGIN_IDS in
 * src/main/services/retired-plugin-cleanup.ts.
 */
export const RETIRED_BUILTIN_PLUGIN_IDS: ReadonlySet<string> = new Set([
  'hub', 'sessions', 'agent-queue',
  ...Object.keys(RETIRED_PLUGINS),
]);

/** Experimental flags for features that were removed rather than graduated. */
export const RETIRED_EXPERIMENTAL_FLAGS: readonly string[] = ['assistant', 'agentQueue', 'sessions'];

const FALLBACK_EXPLORER_TAB: ExplorerTab = 'agents';

/**
 * A removed plugin's id. A built-in id stays when a registered plugin (say, a
 * community one) reuses it; a retired Workshop id never does, because any
 * plugin with that id is refused.
 */
function isRemoved(pluginId: string, isRegistered: (pluginId: string) => boolean): boolean {
  if (!RETIRED_BUILTIN_PLUGIN_IDS.has(pluginId)) return false;
  return isRetiredPlugin(pluginId) || !isRegistered(pluginId);
}

/**
 * Drop retired built-in plugin IDs from an enabled-plugin list. An ID is kept
 * when a plugin with that ID is currently registered (e.g. a community plugin
 * that happens to reuse the name).
 */
export function stripRetiredPluginIds(
  ids: readonly string[],
  isRegistered: (pluginId: string) => boolean = () => false,
): { ids: string[]; changed: boolean } {
  const kept = ids.filter((id) => !isRemoved(id, isRegistered));
  return { ids: kept, changed: kept.length !== ids.length };
}

/** Plugin ID addressed by an explorer tab (`plugin:<id>` or `plugin:app:<id>`), if any. */
function pluginIdForTab(tab: ExplorerTab): string | null {
  if (tab.startsWith('plugin:app:')) return tab.slice('plugin:app:'.length);
  if (tab.startsWith('plugin:')) return tab.slice('plugin:'.length);
  return null;
}

/** Map a tab that points at a retired built-in plugin, or the removed Assistant, to the Agents tab. */
export function migrateRetiredExplorerTab(
  tab: ExplorerTab,
  isRegistered: (pluginId: string) => boolean = () => false,
): ExplorerTab {
  if (tab === 'assistant') return FALLBACK_EXPLORER_TAB;
  const pluginId = pluginIdForTab(tab);
  if (pluginId && isRemoved(pluginId, isRegistered)) {
    return FALLBACK_EXPLORER_TAB;
  }
  return tab;
}
