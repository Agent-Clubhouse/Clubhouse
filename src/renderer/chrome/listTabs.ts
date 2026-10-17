import { usePluginStore } from '../plugins/plugin-store';
import { useUIStore } from '../stores/uiStore';
import { useProjectStore } from '../stores/projectStore';
import { isRemoteProjectId } from '../stores/remoteProjectStore';

/**
 * Plugin tabs whose list the new chrome does not show, because the sidebar
 * selection already says what they point at (spec §4.5): Terminal's list is
 * just its targets. Remote projects have no scope (scope.ts), so they keep
 * the list; without it a remote Terminal could only reach the project root.
 */
const SCOPE_REPLACES_LIST = new Set(['terminal']);

/** True when `explorerTab` is a project tab with its own list (`sidebar-content` layout). */
export function isListTab(
  explorerTab: string,
  layout: 'sidebar-content' | 'full' | undefined,
  opts: { remote?: boolean } = {},
): boolean {
  if (!explorerTab.startsWith('plugin:') || explorerTab.startsWith('plugin:app:')) return false;
  const pluginId = explorerTab.slice('plugin:'.length);
  if (SCOPE_REPLACES_LIST.has(pluginId) && !opts.remote) return false;
  return (layout ?? 'sidebar-content') === 'sidebar-content';
}

/** What the sidebar body shows: the agent tree, a project tab's list, the settings navigator, or Help topics. */
export type SidebarMode = 'tree' | 'list' | 'settings' | 'help';

export function useSidebarMode(): SidebarMode {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const pluginId = explorerTab.startsWith('plugin:') && !explorerTab.startsWith('plugin:app:') ? explorerTab.slice('plugin:'.length) : null;
  const layout = usePluginStore((s) => (pluginId ? s.plugins[pluginId]?.manifest.contributes?.tab?.layout : undefined));
  const remote = useProjectStore((s) => (s.activeProjectId ? isRemoteProjectId(s.activeProjectId) : false));
  if (explorerTab === 'settings') return 'settings';
  if (explorerTab === 'help') return 'help';
  return isListTab(explorerTab, layout, { remote }) ? 'list' : 'tree';
}
