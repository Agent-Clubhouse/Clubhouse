import { useEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../stores/uiStore';
import { useAgentStore } from '../stores/agentStore';
import { useQuickAgentStore } from '../stores/quickAgentStore';
import { useProjectStore } from '../stores/projectStore';
import { AgentTerminal } from '../features/agents/AgentTerminal';
import { SleepingAgent } from '../features/agents/SleepingAgent';
import { HeadlessAgentView } from '../features/agents/HeadlessAgentView';
import { AgentSettingsView } from '../features/agents/AgentSettingsView';
import { QuickAgentGhost } from '../features/agents/QuickAgentGhost';
import { PoppedOutPlaceholder } from '../features/popout/PoppedOutPlaceholder';
import { usePopouts } from '../hooks/usePopouts';
import { ProjectSettings } from '../features/settings/ProjectSettings';
import { NotificationSettingsView } from '../features/settings/NotificationSettingsView';
import { SoundSettingsView } from '../features/settings/SoundSettingsView';
import { DisplaySettingsView } from '../features/settings/DisplaySettingsView';
import { OrchestratorSettingsView } from '../features/settings/OrchestratorSettingsView';
import { ProfilesSettingsView } from '../features/settings/ProfilesSettingsView';
import { PluginContentView } from './PluginContentView';
import { PluginDetailSettings } from '../features/settings/PluginDetailSettings';
import { PluginListSettings } from '../features/settings/PluginListSettings';
import { AboutSettingsView } from '../features/settings/AboutSettingsView';
import { LoggingSettingsView } from '../features/settings/LoggingSettingsView';
import { UpdateSettingsView } from '../features/settings/UpdateSettingsView';
import { AnnexSettingsView } from '../features/settings/AnnexSettingsView';
import { AnnexControlSettingsView } from '../features/settings/AnnexControlSettingsView';
import { WhatsNewSettingsView } from '../features/settings/WhatsNewSettingsView';
import { GettingStartedSettingsView } from '../features/settings/GettingStartedSettingsView';
import { KeyboardShortcutsSettingsView } from '../features/settings/KeyboardShortcutsSettingsView';
import { EditorSettingsView } from '../features/settings/EditorSettingsView';
import { ExperimentalSettingsView } from '../features/settings/ExperimentalSettingsView';
import { useRemoteProjectStore } from '../stores/remoteProjectStore';

export function MainContentView() {
  const explorerTab = useUIStore((s) => s.explorerTab);
  const settingsSubPage = useUIStore((s) => s.settingsSubPage);
  const settingsContext = useUIStore((s) => s.settingsContext);
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const localAgents = useAgentStore((s) => s.agents);
  const remoteAgents = useRemoteProjectStore((s) => s.remoteAgents);
  const agentSettingsOpenFor = useAgentStore((s) => s.agentSettingsOpenFor);
  const selectedCompletedId = useQuickAgentStore((s) => s.selectedCompletedId);
  const completedAgentsMap = useQuickAgentStore((s) => s.completedAgents);
  const selectCompleted = useQuickAgentStore((s) => s.selectCompleted);
  const dismissCompleted = useQuickAgentStore((s) => s.dismissCompleted);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const { findAgentPopout } = usePopouts();
  const isRemoteProject = activeProjectId?.startsWith('remote:') ?? false;
  const agents = isRemoteProject ? { ...localAgents, ...remoteAgents } : localAgents;

  // Track whether the agent terminal should receive focus.
  // Must transition false→true to trigger AgentTerminal's focus useEffect,
  // including on project switches where explorerTab stays 'agents'.
  const isAgentView = explorerTab === 'agents';
  const [terminalFocused, setTerminalFocused] = useState(false);
  const prevProjectIdRef = useRef(activeProjectId);

  useEffect(() => {
    if (!isAgentView) {
      setTerminalFocused(false);
      return;
    }

    const projectChanged = prevProjectIdRef.current !== activeProjectId;
    prevProjectIdRef.current = activeProjectId;

    if (projectChanged) {
      // Force a false→true transition so AgentTerminal re-focuses
      setTerminalFocused(false);
      const raf = requestAnimationFrame(() => setTerminalFocused(true));
      return () => cancelAnimationFrame(raf);
    }

    setTerminalFocused(true);
  }, [isAgentView, activeProjectId]);

  const selectedCompleted = useMemo(() => {
    if (!selectedCompletedId) return null;
    for (const records of Object.values(completedAgentsMap)) {
      const found = records.find((r) => r.id === selectedCompletedId);
      if (found) return found;
    }
    return null;
  }, [selectedCompletedId, completedAgentsMap]);

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

    // Show placeholder when this agent is popped out
    if (activeAgentId) {
      const agentPopout = findAgentPopout(activeAgentId);
      if (agentPopout) {
        return (
          <PoppedOutPlaceholder
            type="agent"
            name={activeAgent?.name}
            windowId={agentPopout.windowId}
          />
        );
      }
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
        <AgentTerminal agentId={activeAgentId!} focused={terminalFocused} />
      </div>
    );
  }

  if (explorerTab === 'settings') {
    const projectId = settingsContext !== 'app' ? settingsContext : undefined;
    if (settingsSubPage === 'orchestrators') return <OrchestratorSettingsView projectId={projectId} />;
    if (settingsSubPage === 'profiles') return <ProfilesSettingsView />;
    if (settingsSubPage === 'notifications') return <NotificationSettingsView projectId={projectId} />;
    if (settingsSubPage === 'sounds') return <SoundSettingsView projectId={projectId} />;
    if (settingsSubPage === 'logging') return <LoggingSettingsView />;
    if (settingsSubPage === 'display') return <DisplaySettingsView />;
    if (settingsSubPage === 'editor') return <EditorSettingsView />;
    if (settingsSubPage === 'plugin-detail') return <PluginDetailSettings />;
    if (settingsSubPage === 'plugins') return <PluginListSettings />;
    if (settingsSubPage === 'annex') return <AnnexSettingsView />;
    if (settingsSubPage === 'annex-control') return <AnnexControlSettingsView />;
    if (settingsSubPage === 'updates') return <UpdateSettingsView />;
    if (settingsSubPage === 'whats-new') return <WhatsNewSettingsView />;
    if (settingsSubPage === 'getting-started') return <GettingStartedSettingsView />;
    if (settingsSubPage === 'keyboard-shortcuts') return <KeyboardShortcutsSettingsView />;
    if (settingsSubPage === 'experimental') return <ExperimentalSettingsView />;
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
