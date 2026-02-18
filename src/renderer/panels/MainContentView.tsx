import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useProjectStore } from '../stores/projectStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { SleepingAgent } from '../features/agents/SleepingAgent';
import { HeadlessAgentView } from '../features/agents/HeadlessAgentView';
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
import { UpdateSettingsView } from '../features/settings/UpdateSettingsView';

export function MainContentView() {
  const { explorerTab, settingsSubPage, settingsContext } = useUIStore();
  const { activeAgentId, agents, agentSettingsOpenFor } = useAgentStore();
  const selectedCompleted = useQuickAgentStore((s) => s.getSelectedCompleted());
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  if (explorerTab === 'agents') {
    const rawAgent = activeAgentId ? agents[activeAgentId] : null;
    // Guard: never show an agent from a different project
    const activeAgent = rawAgent && rawAgent.projectId === activeProjectId ? rawAgent : null;

    if (
      agentSettingsOpenFor &&
      agentSettingsOpenFor === activeAgentId &&
      activeAgent &&
      activeAgent.kind === 'durable'
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
        <div className="flex items-center justify-center h-full bg-ctp-base" data-testid="no-active-agent">
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

    // Headless running agents get the animated clubhouse view instead of a terminal
    if (activeAgent.headless) {
      return <HeadlessAgentView agent={activeAgent} />;
    }

    return (
      <div className="h-full bg-ctp-base" data-testid="agent-terminal-view">
        <AgentTerminal agentId={activeAgentId!} />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    const projectId = settingsContext !== 'app' ? settingsContext : undefined;
    if (settingsSubPage === 'orchestrators') return <OrchestratorSettingsView projectId={projectId} />;
    if (settingsSubPage === 'notifications') return <NotificationSettingsView projectId={projectId} />;
    if (settingsSubPage === 'logging') return <LoggingSettingsView />;
    if (settingsSubPage === 'display') return <DisplaySettingsView />;
    if (settingsSubPage === 'plugin-detail') return <PluginDetailSettings />;
    if (settingsSubPage === 'plugins') return <PluginListSettings />;
    if (settingsSubPage === 'updates') return <UpdateSettingsView />;
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
