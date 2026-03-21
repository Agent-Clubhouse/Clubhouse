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
import { McpSettingsView } from '../features/settings/McpSettingsView';
import { useRemoteProjectStore, isRemoteProjectId, parseNamespacedId } from '../stores/remoteProjectStore';
import { AnnexDisabledView } from './AnnexDisabledView';
import { SatelliteDisconnectedOverlay } from './SatelliteDisconnectedOverlay';
import { useAnnexClientStore } from '../stores/annexClientStore';

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
  const isRemoteProject = activeProjectId ? isRemoteProjectId(activeProjectId) : false;
  const pluginMatchState = useRemoteProjectStore((s) => s.pluginMatchState);
  const agents = isRemoteProject ? { ...localAgents, ...remoteAgents } : localAgents;
  const satellitePaused = useAnnexClientStore((s) => s.satellitePaused);
  const satellites = useAnnexClientStore((s) => s.satellites);

  // Determine if the active remote project's satellite is disconnected
  const remoteParsed = activeProjectId && isRemoteProject ? parseNamespacedId(activeProjectId) : null;
  const activeSatellite = remoteParsed
    ? satellites.find((s) => s.id === remoteParsed.satelliteId || s.fingerprint === remoteParsed.satelliteId)
    : null;
  const isSatelliteDisconnected = activeSatellite ? activeSatellite.state !== 'connected' : false;

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
        <div className="relative flex items-center justify-center h-full bg-ctp-base" data-testid="no-active-agent">
          <div className="text-center text-ctp-subtext0">
            <p className="text-lg mb-2">No active agent</p>
            <p className="text-sm">Add an agent from the sidebar to get started</p>
          </div>
          {isSatelliteDisconnected && activeSatellite && (
            <SatelliteDisconnectedOverlay
              satelliteId={activeSatellite.fingerprint}
              satelliteAlias={activeSatellite.alias}
              satelliteState={activeSatellite.state}
            />
          )}
        </div>
      );
    }

    if (activeAgent.status === 'sleeping' || activeAgent.status === 'error') {
      return (
        <div className="relative h-full">
          <SleepingAgent agent={activeAgent} />
          {isSatelliteDisconnected && activeSatellite && (
            <SatelliteDisconnectedOverlay
              satelliteId={activeSatellite.fingerprint}
              satelliteAlias={activeSatellite.alias}
              satelliteState={activeSatellite.state}
            />
          )}
        </div>
      );
    }

    // Headless running agents get the animated clubhouse view instead of a terminal
    if (activeAgent.headless) {
      return (
        <div className="relative h-full">
          <HeadlessAgentView agent={activeAgent} />
          {isSatelliteDisconnected && activeSatellite && (
            <SatelliteDisconnectedOverlay
              satelliteId={activeSatellite.fingerprint}
              satelliteAlias={activeSatellite.alias}
              satelliteState={activeSatellite.state}
            />
          )}
        </div>
      );
    }

    // Check if viewing a remote agent whose satellite has paused
    const remoteParts = activeAgentId ? parseNamespacedId(activeAgentId) : null;
    const isSatellitePaused = remoteParts ? satellitePaused[remoteParts.satelliteId] : false;

    return (
      <div className="relative h-full bg-ctp-base" data-testid="agent-terminal-view">
        <AgentTerminal agentId={activeAgentId!} focused={terminalFocused} />
        {isSatellitePaused && (
          <div className="absolute inset-0 flex items-center justify-center bg-ctp-base/80 z-10">
            <div className="text-center">
              <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-surface-2 flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-ctp-subtext0">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              </div>
              <p className="text-sm text-ctp-subtext0 font-medium">Session paused by remote</p>
              <p className="text-xs text-ctp-overlay0 mt-1">The satellite has paused remote control</p>
            </div>
          </div>
        )}
        {isSatelliteDisconnected && activeSatellite && (
          <SatelliteDisconnectedOverlay
            satelliteId={activeSatellite.fingerprint}
            satelliteAlias={activeSatellite.alias}
            satelliteState={activeSatellite.state}
          />
        )}
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
    if (settingsSubPage === 'mcp') return <McpSettingsView />;
    if (settingsSubPage === 'experimental') return <ExperimentalSettingsView />;
    if (settingsSubPage === 'about') return <AboutSettingsView />;
    return <ProjectSettings projectId={projectId} />;
  }

  // Plugin tabs (prefixed with "plugin:")
  if (explorerTab.startsWith('plugin:')) {
    const pluginId = explorerTab.slice('plugin:'.length);

    // For remote projects, check if the plugin has annex permission
    if (isRemoteProject && activeProjectId) {
      const parsed = parseNamespacedId(activeProjectId);
      if (parsed) {
        const matches = pluginMatchState[parsed.satelliteId] || [];
        const match = matches.find((p) => p.id === pluginId);
        if (match && !match.annexEnabled) {
          return <AnnexDisabledView pluginName={match.name} />;
        }
      }
    }

    return (
      <div className="relative h-full">
        <PluginContentView pluginId={pluginId} mode="project" />
        {isSatelliteDisconnected && activeSatellite && (
          <SatelliteDisconnectedOverlay
            satelliteId={activeSatellite.fingerprint}
            satelliteAlias={activeSatellite.alias}
            satelliteState={activeSatellite.state}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full bg-ctp-base">
      <p className="text-ctp-subtext0">
        Select a tab from the explorer
      </p>
    </div>
  );
}
