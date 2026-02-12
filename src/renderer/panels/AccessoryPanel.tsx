import { useUIStore } from '../stores/uiStore';
import { AgentList } from '../features/agents/AgentList';
import { GitSidebar } from '../features/git/GitSidebar';
import { FileTree } from '../features/files/FileTree';
import { NotesTree } from '../features/notes/NotesTree';
import { SchedulerList } from '../features/scheduler/SchedulerList';

export function AccessoryPanel() {
  const { explorerTab, settingsSubPage, setSettingsSubPage } = useUIStore();

  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
      {explorerTab === 'agents' && <AgentList />}
      {explorerTab === 'files' && <FileTree />}
      {explorerTab === 'git' && <GitSidebar />}
      {explorerTab === 'notes' && <NotesTree />}
      {explorerTab === 'scheduler' && <SchedulerList />}
      {explorerTab === 'settings' && (
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
          </nav>
        </div>
      )}
    </div>
  );
}
