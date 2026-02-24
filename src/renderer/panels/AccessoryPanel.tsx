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
  const settingsContext = useUIStore((s) => s.settingsContext);
  const settingsSubPage = useUIStore((s) => s.settingsSubPage);
  const setSettingsSubPage = useUIStore((s) => s.setSettingsSubPage);

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
      <nav className="py-1 flex-1 flex flex-col min-h-0 overflow-y-auto">
        {isApp ? (
          <>
            {navButton('About', 'about')}
            {navButton('Orchestrators & Agents', 'orchestrators')}
            {navButton('Display & UI', 'display')}
            {navButton('Keyboard Shortcuts', 'keyboard-shortcuts')}
            {navButton('Notifications', 'notifications')}
            {navButton('Sounds', 'sounds')}
            {navButton('Plugins', 'plugins')}
            {navButton('Annex', 'annex')}
            {navButton('Updates', 'updates')}
            {navButton('Logging', 'logging')}
            {navButton('Getting Started', 'getting-started')}
            {navButton("What's New", 'whats-new')}
          </>
        ) : (
          <>
            {navButton('Project Settings', 'project')}
            {navButton('Orchestrators & Agents', 'orchestrators')}
            {navButton('Notifications', 'notifications')}
            {navButton('Sounds', 'sounds')}
            {navButton('Plugins', 'plugins')}
          </>
        )}
      </nav>
    </div>
  );
}

function PluginSidebarPanel({ pluginId }: { pluginId: string }) {
  const mod = usePluginStore((s) => s.modules[pluginId]);
  const entry = usePluginStore((s) => s.plugins[pluginId]);
  const contextRevision = usePluginStore((s) => s.contextRevision);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  if (!mod?.SidebarPanel) return null;

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
  const explorerTab = useUIStore((s) => s.explorerTab);
  const activePluginId = explorerTab.startsWith('plugin:') ? explorerTab.slice('plugin:'.length) : null;
  const activePluginEntry = usePluginStore((s) => activePluginId ? s.plugins[activePluginId] : undefined);

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
  if (activePluginId) {
    const layout = activePluginEntry?.manifest.contributes?.tab?.layout ?? 'sidebar-content';

    if (layout === 'sidebar-content') {
      return (
        <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full min-h-0 overflow-hidden">
          <PluginSidebarPanel pluginId={activePluginId} />
        </div>
      );
    }
  }

  return null;
}
