import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useProjectStore } from '../stores/projectStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { SleepingAgent } from '../features/agents/SleepingAgent';
import { AgentSettingsView } from '../features/agents/AgentSettingsView';
import { QuickAgentGhost } from '../features/agents/QuickAgentGhost';
import { ProjectSettings } from '../features/settings/ProjectSettings';
import { NotificationSettingsView } from '../features/settings/NotificationSettingsView';
import { DisplaySettingsView } from '../features/settings/DisplaySettingsView';
import { OrchestratorSettingsView } from '../features/settings/OrchestratorSettingsView';
import { PluginContentView } from './PluginContentView';
import { PluginDetailSettings } from '../features/settings/PluginDetailSettings';
import { PluginListSettings } from '../features/settings/PluginListSettings';
import { AboutSettingsView } from '../features/settings/AboutSettingsView';
import { LoggingSettingsView } from '../features/settings/LoggingSettingsView';

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
      return <SleepingAgent agent={activeAgent} />;
    }

    return (
      <div className="h-full bg-ctp-base">
        <AgentTerminal agentId={activeAgentId!} />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    const projectId = settingsContext !== 'app' ? settingsContext : undefined;
    if (settingsSubPage === 'orchestrators') return <OrchestratorSettingsView />;
    if (settingsSubPage === 'notifications') return <NotificationSettingsView />;
    if (settingsSubPage === 'logging') return <LoggingSettingsView />;
    if (settingsSubPage === 'display') return <DisplaySettingsView />;
    if (settingsSubPage === 'plugin-detail') return <PluginDetailSettings />;
    if (settingsSubPage === 'plugins') return <PluginListSettings />;
    if (settingsSubPage === 'about') return <AboutSettingsView />;
    return <ProjectSettings projectId={projectId} />;
  }

  // Plugin tabs (prefixed with "plugin:")
  if (explorerTab.startsWith('plugin:')) {
    const pluginId = explorerTab.slice('plugin:'.length);
    return <PluginContentView pluginId={pluginId} mode="project" />;
  }

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <p className="text-ctp-subtext0">
        Select a tab from the explorer
      </p>
    </div>
  );
}
