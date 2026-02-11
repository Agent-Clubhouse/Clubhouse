import { useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { AgentList } from '../features/agents/AgentList';
import { GitSidebar } from '../features/git/GitSidebar';
import { FileTree } from '../features/files/FileTree';

export function AccessoryPanel() {
  const { explorerTab } = useUIStore();
  const [selectedGitFile, setSelectedGitFile] = useState<string | null>(null);

  return (
    <div className="flex flex-col bg-ctp-base border-r border-surface-0 h-full overflow-hidden">
      {explorerTab === 'agents' && <AgentList />}
      {explorerTab === 'files' && <FileTree />}
      {explorerTab === 'git' && (
        <GitSidebar onSelectFile={setSelectedGitFile} />
      )}
      {explorerTab === 'settings' && (
        <div className="flex flex-col h-full">
          <div className="px-3 py-2 border-b border-surface-0">
            <span className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Settings</span>
          </div>
          <nav className="py-1">
            <div className="px-3 py-2 text-sm text-ctp-text bg-surface-1 cursor-pointer">
              Project Defaults
            </div>
          </nav>
        </div>
      )}
    </div>
  );
}
