import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { SleepingClaude } from '../features/agents/SleepingClaude';
import { AgentSettingsView } from '../features/agents/AgentSettingsView';
import { QuickAgentGhost } from '../features/hub/QuickAgentGhost';
import { GitLog } from '../features/git/GitLog';
import { GitDiffViewer } from '../features/git/GitDiffViewer';
import { FileViewer } from '../features/files/FileViewer';
import { ProjectSettings } from '../features/settings/ProjectSettings';
import { NotificationSettingsView } from '../features/settings/NotificationSettingsView';
import { StandaloneTerminal } from '../features/terminal/StandaloneTerminal';
import { CommandCenter } from '../features/hub/CommandCenter';

export function MainContentView() {
  const { explorerTab, selectedGitFile, settingsSubPage } = useUIStore();
  const { activeAgentId, agents, agentSettingsOpenFor } = useAgentStore();
  const selectedCompleted = useQuickAgentStore((s) => s.getSelectedCompleted());
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);

  if (explorerTab === 'agents') {
    const activeAgent = activeAgentId ? agents[activeAgentId] : null;

    // Show settings view if open for the active durable agent
    if (
      agentSettingsOpenFor &&
      agentSettingsOpenFor === activeAgentId &&
      activeAgent &&
      activeAgent.kind === 'durable' &&
      activeAgent.worktreePath
    ) {
      return <AgentSettingsView agent={activeAgent} />;
    }

    if (!activeAgent) {
      if (selectedCompleted) {
        return (
          <QuickAgentGhost
            completed={selectedCompleted}
            onDismiss={() => selectCompleted(null)}
          />
        );
      }
      return (
        <div className="flex items-center justify-center h-full bg-ctp-base">
          <div className="text-center text-ctp-subtext0">
            <p className="text-lg mb-2">No active agent</p>
            <p className="text-sm">Add an agent from the sidebar to get started</p>
          </div>
        </div>
      );
    }

    if (activeAgent.status === 'sleeping' || activeAgent.status === 'error') {
      return <SleepingClaude agent={activeAgent} />;
    }

    return (
      <div className="h-full bg-ctp-base">
        <AgentTerminal agentId={activeAgentId!} />
      </div>
    );
  }

  if (explorerTab === 'hub') {
    return <CommandCenter />;
  }

  if (explorerTab === 'terminal') {
    return <StandaloneTerminal />;
  }

  if (explorerTab === 'files') {
    return <FileViewer />;
  }

  if (explorerTab === 'git') {
    return selectedGitFile ? <GitDiffViewer /> : <GitLog />;
  }

  if (explorerTab === 'settings') {
    return settingsSubPage === 'notifications' ? <NotificationSettingsView /> : <ProjectSettings />;
  }

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <p className="text-ctp-subtext0">
        Select a tab from the explorer
      </p>
    </div>
  );
}
