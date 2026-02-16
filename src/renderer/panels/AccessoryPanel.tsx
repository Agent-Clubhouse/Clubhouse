import { useUIStore } from '../stores/uiStore';
import { AgentList } from '../features/agents/AgentList';
import { getPlugin } from '../plugins';

export function AccessoryPanel() {
  const { explorerTab, settingsSubPage, setSettingsSubPage } = useUIStore();

  // Core tabs with explicit handling
  if (explorerTab === 'agents') {
    return (
      <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
        <AgentList />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    return (
      <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
        <div className="flex flex-col h-full">
          <div className="px-3 py-2 border-b border-surface-0">
            <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Settings</span>
          </div>
          <nav className="py-1">
            <button
              onClick={() => setSettingsSubPage('project')}
              className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
                settingsSubPage === 'project' ? 'text-ctp-text bg-surface-1' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }`}
            >
              Project Settings
            </button>
            <button
              onClick={() => setSettingsSubPage('notifications')}
              className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
                settingsSubPage === 'notifications' ? 'text-ctp-text bg-surface-1' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }`}
            >
              Notifications
            </button>
            <button
              onClick={() => setSettingsSubPage('display')}
              className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
                settingsSubPage === 'display' ? 'text-ctp-text bg-surface-1' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }`}
            >
              Display & UI
            </button>
            <button
              onClick={() => setSettingsSubPage('plugins')}
              className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
                settingsSubPage === 'plugins' ? 'text-ctp-text bg-surface-1' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
              }`}
            >
              Plugins
            </button>
          </nav>
        </div>
      </div>
    );
  }

  // Generic plugin lookup fallback
  const plugin = getPlugin(explorerTab);
  if (plugin?.SidebarPanel) {
    const SidebarPanel = plugin.SidebarPanel;
    return (
      <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
        <SidebarPanel />
      </div>
    );
  }

  return <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden" />;
}
