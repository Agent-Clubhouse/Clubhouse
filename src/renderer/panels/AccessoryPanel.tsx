import { useUIStore } from '../stores/uiStore';
import { AgentList } from '../features/agents/AgentList';
import { SettingsSubPage } from '../../shared/types';

function SettingsCategoryNav() {
  const { settingsContext, settingsSubPage, setSettingsSubPage } = useUIStore();

  const navButton = (label: string, page: SettingsSubPage) => (
    <button
      onClick={() => setSettingsSubPage(page)}
      className={`w-full px-3 py-2 text-sm text-left cursor-pointer ${
        settingsSubPage === page ? 'text-ctp-text bg-surface-1' : 'text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-subtext1'
      }`}
    >
      {label}
    </button>
  );

  const isApp = settingsContext === 'app';

  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-surface-0">
        <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">
          {isApp ? 'App Settings' : 'Project Settings'}
        </span>
      </div>
      <nav className="py-1">
        {isApp ? (
          <>
            {navButton('Orchestrators', 'orchestrators')}
            {navButton('Display & UI', 'display')}
            {navButton('Notifications', 'notifications')}
          </>
        ) : (
          <>
            {navButton('Project Settings', 'project')}
          </>
        )}
      </nav>
    </div>
  );
}

export function AccessoryPanel() {
  const { explorerTab } = useUIStore();

  if (explorerTab === 'agents') {
    return (
      <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
        <AgentList />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    return <SettingsCategoryNav />;
  }

  return <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden" />;
}
