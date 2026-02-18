import { useUIStore } from '../stores/uiStore';
import { usePluginStore } from '../plugins/plugin-store';
import { useProjectStore } from '../stores/projectStore';
import { PluginAPIProvider } from '../plugins/plugin-context';
import { createPluginAPI } from '../plugins/plugin-api-factory';
import { getActiveContext } from '../plugins/plugin-loader';
import { PluginErrorBoundary } from './PluginContentView';
import { AgentList } from '../features/agents/AgentList';
import { SettingsSubPage } from '../../shared/types';

function SettingsCategoryNav() {
  const { settingsContext, settingsSubPage, setSettingsSubPage } = useUIStore();

  const navButton = (label: string, page: SettingsSubPage) => (
    <button
      onClick={() => setSettingsSubPage(page)}
      className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
        settingsSubPage === page || (page === 'plugins' && settingsSubPage === 'plugin-detail')
          ? 'text-ctp-text bg-surface-1'
          : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
      }`}
    >
      {label}
    </button>
  );

  const isApp = settingsContext === 'app';

  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          {isApp ? 'App Settings' : 'Project Settings'}
        </span>
      </div>
      <nav className="py-1 flex-1 flex flex-col">
        {isApp ? (
          <>
            {navButton('About', 'about')}
            {navButton('Agents', 'orchestrators')}
            {navButton('Display & UI', 'display')}
            {navButton('Notifications', 'notifications')}
            {navButton('Logging', 'logging')}
            {navButton('Plugins', 'plugins')}
            {navButton('Updates', 'updates')}
          </>
        ) : (
          <>
            {navButton('Project Settings', 'project')}
            {navButton('Agents', 'orchestrators')}
            {navButton('Notifications', 'notifications')}
            {navButton('Plugins', 'plugins')}
          </>
        )}
      </nav>
    </div>
  );
}

function PluginSidebarPanel({ pluginId }: { pluginId: string }) {
  const modules = usePluginStore((s) => s.modules);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const mod = modules[pluginId];
  if (!mod?.SidebarPanel) return null;

  const plugins = usePluginStore((s) => s.plugins);
  const entry = plugins[pluginId];

  const ctx = getActiveContext(pluginId, activeProjectId || undefined);
  if (!ctx) return null;

  const api = createPluginAPI(ctx, undefined, entry?.manifest);
  const SidebarPanel = mod.SidebarPanel;

  return (
    <PluginErrorBoundary key={pluginId} pluginId={pluginId}>
      <PluginAPIProvider api={api}>
        <SidebarPanel api={api} />
      </PluginAPIProvider>
    </PluginErrorBoundary>
  );
}

export function AccessoryPanel() {
  const { explorerTab } = useUIStore();

  if (explorerTab === 'agents') {
    return (
      <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden">
        <AgentList />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    return <SettingsCategoryNav />;
  }

  // Plugin tabs with sidebar layout
  if (explorerTab.startsWith('plugin:')) {
    const pluginId = explorerTab.slice('plugin:'.length);
    const entry = usePluginStore.getState().plugins[pluginId];
    const layout = entry?.manifest.contributes?.tab?.layout ?? 'sidebar-content';

    if (layout === 'sidebar-content') {
      return (
        <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden">
          <PluginSidebarPanel pluginId={pluginId} />
        </div>
      );
    }
  }

  return null;
}
