import { usePluginStore } from '../plugins/plugin-store';
import { useUIStore } from '../stores/uiStore';

/**
 * Plugin tabs whose list the new chrome does not show, because the sidebar
 * selection already says what they point at (spec §4.5): Terminal's list is
 * just its targets.
 */
const SCOPE_REPLACES_LIST = new Set(['terminal']);

/** True when `explorerTab` is a project tab with its own list (`sidebar-content` layout). */
export function isListTab(explorerTab: string, layout: 'sidebar-content' | 'full' | undefined): boolean {
  if (!explorerTab.startsWith('plugin:') || explorerTab.startsWith('plugin:app:')) return false;
  const pluginId = explorerTab.slice('plugin:'.length);
  if (SCOPE_REPLACES_LIST.has(pluginId)) return false;
  return (layout ?? 'sidebar-content') === 'sidebar-content';
}

/** What the sidebar body shows: the agent tree, a project tab's list, the settings navigator, or Help topics. */
export type SidebarMode = 'tree' | 'list' | 'settings' | 'help';

export function useSidebarMode(): SidebarMode {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const pluginId = explorerTab.startsWith('plugin:') && !explorerTab.startsWith('plugin:app:') ? explorerTab.slice('plugin:'.length) : null;
  const layout = usePluginStore((s) => (pluginId ? s.plugins[pluginId]?.manifest.contributes?.tab?.layout : undefined));
  if (explorerTab === 'settings') return 'settings';
  if (explorerTab === 'help') return 'help';
  return isListTab(explorerTab, layout) ? 'list' : 'tree';
}
