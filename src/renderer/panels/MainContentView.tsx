import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useProjectStore } from '../stores/projectStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { SleepingClaude } from '../features/agents/SleepingClaude';
import { AgentSettingsView } from '../features/agents/AgentSettingsView';
import { QuickAgentGhost } from '../features/hub/QuickAgentGhost';
import { ProjectSettings } from '../features/settings/ProjectSettings';
import { NotificationSettingsView } from '../features/settings/NotificationSettingsView';
import { DisplaySettingsView } from '../features/settings/DisplaySettingsView';
import { PluginSettingsView } from '../features/settings/PluginSettingsView';
import { CommandCenter } from '../features/hub/CommandCenter';
import { StandaloneTerminal } from '../features/terminal/StandaloneTerminal';
import { getPlugin } from '../plugins';

export function MainContentView() {
  const { explorerTab, settingsSubPage, settingsContext } = useUIStore();
  const { activeAgentId, agents, agentSettingsOpenFor } = useAgentStore();
  const selectedCompleted = useQuickAgentStore((s) => s.getSelectedCompleted());
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  if (explorerTab === 'agents') {
    const activeAgent = activeAgentId ? agents[activeAgentId] : null;

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
            onDelete={() => {
              if (activeProjectId) dismissCompleted(activeProjectId, selectedCompleted.id);
              selectCompleted(null);
            }}
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

  if (explorerTab === 'settings') {
    const projectId = settingsContext !== 'app' ? settingsContext : undefined;
    if (settingsSubPage === 'notifications') return <NotificationSettingsView />;
    if (settingsSubPage === 'display') return <DisplaySettingsView />;
    if (settingsSubPage === 'plugins') return <PluginSettingsView projectId={projectId} />;
    return <ProjectSettings projectId={projectId} />;
  }

  // --- Generic plugin lookup fallback ---

  const plugin = getPlugin(explorerTab);
  if (plugin) {
    const MainPanel = plugin.MainPanel;
    return <MainPanel />;
  }

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <p className="text-ctp-subtext0">
        Select a tab from the explorer
      </p>
    </div>
  );
}
