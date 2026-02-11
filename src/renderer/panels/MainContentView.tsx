import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { GitLog } from '../features/git/GitLog';
import { FileViewer } from '../features/files/FileViewer';
import { ProjectSettings } from '../features/settings/ProjectSettings';

export function MainContentView() {
  const { explorerTab } = useUIStore();
  const { activeAgentId, agents } = useAgentStore();

  if (explorerTab === 'agents') {
    const activeAgent = activeAgentId ? agents[activeAgentId] : null;

    if (!activeAgent) {
      return (
        <div className="flex items-center justify-center h-full bg-ctp-base">
          <div className="text-center text-ctp-subtext0">
            <p className="text-lg mb-2">No active agent</p>
            <p className="text-sm">Add an agent from the sidebar to get started</p>
          </div>
        </div>
      );
    }

    if (activeAgent.status === 'sleeping') {
      return (
        <div className="flex items-center justify-center h-full bg-ctp-base">
          <div className="text-center text-ctp-subtext0">
            <p className="text-lg mb-2">{activeAgent.name}</p>
            <p className="text-sm mb-3">This agent is sleeping</p>
            <p className="text-xs">Click the play button in the sidebar to wake it</p>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full bg-ctp-base">
        <AgentTerminal agentId={activeAgentId!} />
      </div>
    );
  }

  if (explorerTab === 'files') {
    return <FileViewer />;
  }

  if (explorerTab === 'git') {
    return <GitLog />;
  }

  if (explorerTab === 'settings') {
    return <ProjectSettings />;
  }

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <p className="text-ctp-subtext0">
        Select a tab from the explorer
      </p>
    </div>
  );
}
