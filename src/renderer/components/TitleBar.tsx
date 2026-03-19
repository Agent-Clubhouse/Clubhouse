import { useProjectStore } from '../stores/projectStore';
import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';

const CORE_LABELS: Record<string, string> = {
  agents: 'Agents',
  settings: 'Settings',
  help: 'Help',
};

/**
 * Title bar component that subscribes to its own state slices so that
 * title-text recomputation does not force the parent App to re-render.
 */
export function TitleBar() {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const activePluginId = explorerTab.startsWith('plugin:app:')
    ? explorerTab.slice('plugin:app:'.length)
    : explorerTab.startsWith('plugin:')
      ? explorerTab.slice('plugin:'.length)
      : null;
  const activePluginEntry = usePluginStore((s) => activePluginId ? s.plugins[activePluginId] : undefined);
  const dynamicTitle = usePluginStore((s) => activePluginId ? s.pluginTitles[activePluginId] : undefined);

  const isAppPlugin = explorerTab.startsWith('plugin:app:');
  const isHelp = explorerTab === 'help';
  const isHome = activeProjectId === null && explorerTab !== 'settings' && !isAppPlugin && !isHelp;
  const activeProject = projects.find((p) => p.id === activeProjectId);

  const tabLabel = (() => {
    // Dynamic title from window.setTitle() takes priority
    if (dynamicTitle) return dynamicTitle;
    if (!activePluginEntry) return CORE_LABELS[explorerTab] || explorerTab;
    if (explorerTab.startsWith('plugin:app:')) {
      return activePluginEntry.manifest.contributes?.railItem?.title
        || activePluginEntry.manifest.contributes?.railItem?.label
        || activePluginEntry.manifest.name || activePluginId;
    }
    return activePluginEntry.manifest.contributes?.tab?.title
      || activePluginEntry.manifest.contributes?.tab?.label
      || activePluginEntry.manifest.name || activePluginId;
  })();

  const titleText = isHome
    ? 'Home'
    : activeProject
      ? `${tabLabel} (${activeProject.displayName || activeProject.name})`
      : tabLabel;

  const isWin = window.clubhouse.platform === 'win32';
  const titleBarClass = `h-[38px] flex-shrink-0 drag-region bg-ctp-mantle border-b border-surface-0 flex items-center justify-center${isWin ? ' win-overlay-padding' : ''}`;

  return (
    <div className={titleBarClass}>
      <span className="text-xs text-ctp-subtext0 select-none" data-testid="title-bar">{titleText}</span>
    </div>
  );
}
