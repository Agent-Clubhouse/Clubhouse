import { useEffect, useState } from 'react';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore, SpawnMode } from '../../stores/headlessStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { useFreeAgentSettingsStore } from '../../stores/freeAgentSettingsStore';
import { Toggle } from '../../components/Toggle';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';
import type { FreeAgentPermissionMode, SourceControlProvider } from '../../../shared/types';

interface Props {
  projectId?: string;
}

// ── App-level: global headless toggle + orchestrator enable/disable ──────

function AppAgentSettings() {
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const loadSettings = useOrchestratorStore((s) => s.loadSettings);
  const setEnabled = useOrchestratorStore((s) => s.setEnabled);
  const checkAllAvailability = useOrchestratorStore((s) => s.checkAllAvailability);
  const defaultMode = useHeadlessStore((s) => s.defaultMode);
  const setDefaultMode = useHeadlessStore((s) => s.setDefaultMode);
  const clubhouseEnabled = useClubhouseModeStore((s) => s.enabled);
  const setClubhouseEnabled = useClubhouseModeStore((s) => s.setEnabled);
  const loadClubhouseSettings = useClubhouseModeStore((s) => s.loadSettings);
  const clubhouseScp = useClubhouseModeStore((s) => s.sourceControlProvider);
  const setClubhouseScp = useClubhouseModeStore((s) => s.setSourceControlProvider);
  const promptForName = useSessionSettingsStore((s) => s.promptForName);
  const setPromptForName = useSessionSettingsStore((s) => s.setPromptForName);
  const loadSessionSettings = useSessionSettingsStore((s) => s.loadSettings);
  const freeAgentDefaultMode = useFreeAgentSettingsStore((s) => s.defaultMode);
  const setFreeAgentDefaultMode = useFreeAgentSettingsStore((s) => s.setDefaultMode);
  const loadFreeAgentSettings = useFreeAgentSettingsStore((s) => s.loadSettings);
  const [showConfirm, setShowConfirm] = useState(false);

  useEffect(() => {
    loadSettings().then(() => checkAllAvailability());
    loadClubhouseSettings();
    loadSessionSettings();
    loadFreeAgentSettings();
  }, [loadSettings, checkAllAvailability, loadClubhouseSettings, loadSessionSettings, loadFreeAgentSettings]);

  const handleClubhouseToggle = () => {
    if (!clubhouseEnabled) {
      setShowConfirm(true);
    } else {
      setClubhouseEnabled(false);
    }
  };

  const confirmEnable = () => {
    setShowConfirm(false);
    setClubhouseEnabled(true);
  };

  return (
    <>
      {/* Quick Agent Mode dropdown */}
      <div className="space-y-3 mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Quick Agents</h3>
        <div className="space-y-2">
          <label className="block text-sm text-ctp-text">Default Quick Agent Mode</label>
          <select
            value={defaultMode}
            onChange={(e) => setDefaultMode(e.target.value as SpawnMode)}
            className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          >
            <option value="interactive">Interactive</option>
            <option value="headless">Headless</option>
          </select>
          <p className="text-xs text-ctp-subtext0">
            How quick agents run by default. Headless runs faster with richer summaries.
          </p>
        </div>
        <div className="space-y-2">
          <label className="block text-sm text-ctp-text">Free Agent Permission Mode</label>
          <select
            value={freeAgentDefaultMode}
            onChange={(e) => setFreeAgentDefaultMode(e.target.value as FreeAgentPermissionMode)}
            className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          >
            <option value="skip-all">Skip All Permissions (default)</option>
            <option value="auto">Auto (requires CLI support)</option>
          </select>
          <p className="text-xs text-ctp-subtext0">
            How agents handle permissions in Free Agent mode. Skip All bypasses all checks; Auto uses a safety classifier (requires <code className="text-ctp-subtext1">--permission-mode</code> support in your CLI).
          </p>
        </div>
      </div>

      {/* Clubhouse Mode toggle */}
      <div className="space-y-3 mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Durable Agents</h3>
        <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
          <div className="flex items-center gap-2.5">
            <span className="text-ctp-subtext1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </span>
            <div>
              <div className="text-sm text-ctp-text">Clubhouse Mode</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Centrally manage agent instructions, permissions, and MCP config. Settings are pushed to worktrees on agent wake.
              </div>
            </div>
          </div>
          <button
            onClick={handleClubhouseToggle}
            className="toggle-track"
            data-on={String(clubhouseEnabled)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        {clubhouseEnabled && (
          <div className="px-3 py-2 rounded-lg bg-ctp-warning/10 border border-ctp-warning/20 text-xs text-ctp-warning">
            Wildcards <code className="bg-ctp-warning/10 px-1 rounded">@@AgentName</code>, <code className="bg-ctp-warning/10 px-1 rounded">@@StandbyBranch</code>, and <code className="bg-ctp-warning/10 px-1 rounded">@@Path</code> in project defaults are resolved per-agent on each wake.
          </div>
        )}
        {clubhouseEnabled && (
          <div className="space-y-1 pl-3">
            <label className="block text-xs text-ctp-subtext0">Default Source Control Provider</label>
            <select
              value={clubhouseScp}
              onChange={(e) => setClubhouseScp(e.target.value as SourceControlProvider)}
              className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
                text-ctp-text focus:outline-none focus:border-ctp-accent/50"
            >
              <option value="github">GitHub (gh CLI)</option>
              <option value="azure-devops">Azure DevOps (az CLI)</option>
            </select>
            <p className="text-[10px] text-ctp-subtext0/60">
              App-wide default. Projects can override in their own settings.
            </p>
          </div>
        )}

        {/* Session name prompt */}
        <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
          <div>
            <div className="text-sm text-ctp-text">Prompt for Session Name on Quit</div>
            <div className="text-xs text-ctp-subtext0 mt-0.5">
              Ask to name a session when a durable agent stops (default for all projects)
            </div>
          </div>
          <Toggle checked={promptForName} onChange={setPromptForName} />
        </div>
      </div>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-ctp-base border border-surface-1 rounded-xl p-6 max-w-md mx-4 shadow-xl">
            <h3 className="text-sm font-semibold text-ctp-text mb-2">Enable Clubhouse Mode?</h3>
            <p className="text-xs text-ctp-subtext0 mb-4">
              This will overwrite agent settings in worktrees with project-level defaults on each agent wake.
              We recommend committing or backing up your current agent configurations first.
            </p>
            <p className="text-xs text-ctp-subtext0 mb-4">
              Default templates with wildcard support will be created if no project defaults exist yet.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmEnable}
                className="px-3 py-1.5 text-xs rounded-lg bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer transition-colors"
              >
                Enable
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Orchestrators */}
      <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-3">Orchestrators</h3>
      <div className="space-y-3">
        {allOrchestrators.map((o) => {
          const isEnabled = enabled.includes(o.id);
          const avail = availability[o.id];
          const isOnlyEnabled = isEnabled && enabled.length === 1;
          const notInstalled = avail && !avail.available;
          const toggleDisabled = isOnlyEnabled || !!notInstalled;

          return (
            <div key={o.id} className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
              <div className="flex items-center gap-3">
                <div
                  className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                    avail?.available ? 'bg-green-500' : avail ? 'bg-red-500' : 'bg-ctp-overlay0'
                  }`}
                  title={avail?.available ? 'CLI found' : avail?.error || 'Checking...'}
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ctp-text">{o.displayName}</span>
                    {o.badge && (
                      <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 shadow-[0_0_6px_rgba(99,102,241,0.3)]">
                        {o.badge}
                      </span>
                    )}
                  </div>
                  {avail && !avail.available && avail.error && (
                    <div className="text-xs text-ctp-subtext0 mt-0.5">{avail.error}</div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setEnabled(o.id, !isEnabled)}
                disabled={toggleDisabled}
                className="toggle-track"
                data-on={String(isEnabled)}
                title={notInstalled ? 'CLI not found — install to enable' : isOnlyEnabled ? 'At least one orchestrator must be enabled' : undefined}
              >
                <span className="toggle-knob" />
              </button>
            </div>
          );
        })}
      </div>

      {allOrchestrators.length === 0 && (
        <p className="text-sm text-ctp-subtext0">No orchestrators registered.</p>
      )}
    </>
  );
}

// ── Reusable dropdown row for project defaults ──────────────────────────

const DROPDOWN_SELECT_CLASS = 'w-48 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2 text-ctp-text focus:outline-none focus:border-ctp-accent/50';

function DefaultRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex-1 min-w-0 mr-4 overflow-hidden">
        <div className="text-sm text-ctp-text truncate">{label}</div>
        <div className="text-xs text-ctp-subtext0 mt-0.5">{description}</div>
      </div>
      <div className="flex-shrink-0 relative">
        {children}
      </div>
    </div>
  );
}

// ── Project-level: unified project defaults ─────────────────────────────

function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

  const headlessDefaultMode = useHeadlessStore((s) => s.defaultMode);
  const headlessOverrides = useHeadlessStore((s) => s.projectOverrides);
  const setProjectMode = useHeadlessStore((s) => s.setProjectMode);
  const clearProjectMode = useHeadlessStore((s) => s.clearProjectMode);

  const clubhouseGlobal = useClubhouseModeStore((s) => s.enabled);
  const clubhouseOverrides = useClubhouseModeStore((s) => s.projectOverrides);
  const setClubhouseOverride = useClubhouseModeStore((s) => s.setProjectOverride);
  const clearClubhouseOverride = useClubhouseModeStore((s) => s.clearProjectOverride);
  const loadClubhouseSettings = useClubhouseModeStore((s) => s.loadSettings);

  const sessionPromptGlobal = useSessionSettingsStore((s) => s.promptForName);
  const sessionOverrides = useSessionSettingsStore((s) => s.projectOverrides);
  const setSessionOverride = useSessionSettingsStore((s) => s.setProjectOverride);
  const clearSessionOverride = useSessionSettingsStore((s) => s.clearProjectOverride);
  const loadSessionSettings = useSessionSettingsStore((s) => s.loadSettings);

  const freeAgentGlobalMode = useFreeAgentSettingsStore((s) => s.defaultMode);
  const freeAgentOverrides = useFreeAgentSettingsStore((s) => s.projectOverrides);
  const setFreeAgentProjectMode = useFreeAgentSettingsStore((s) => s.setProjectMode);
  const clearFreeAgentProjectMode = useFreeAgentSettingsStore((s) => s.clearProjectMode);
  const loadFreeAgentSettings = useFreeAgentSettingsStore((s) => s.loadSettings);

  const mcpGlobalEnabled = useMcpSettingsStore((s) => s.enabled);
  const mcpProjectOverrides = (useMcpSettingsStore((s) => s.projectOverrides) ?? {}) as Record<string, boolean>;
  const mcpSaveSettings = useMcpSettingsStore((s) => s.saveSettings);
  const mcpLoaded = useMcpSettingsStore((s) => s.loaded);
  const loadMcpSettings = useMcpSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    loadClubhouseSettings();
    loadSessionSettings();
    loadFreeAgentSettings();
    loadMcpSettings();
  }, [loadClubhouseSettings, loadSessionSettings, loadFreeAgentSettings, loadMcpSettings]);

  if (!project) return null;

  const projectPath = project.path;
  const currentOrchestrator = project.orchestrator || 'claude-code';

  // Headless mode
  const hasHeadlessOverride = projectPath in headlessOverrides;
  const currentHeadlessMode = hasHeadlessOverride ? headlessOverrides[projectPath] : 'global';
  const handleHeadlessModeChange = (value: string) => {
    if (value === 'global') clearProjectMode(projectPath);
    else setProjectMode(projectPath, value as SpawnMode);
  };

  // Clubhouse mode
  const hasClubhouseOverride = projectPath in clubhouseOverrides;
  const currentClubhouseMode = hasClubhouseOverride
    ? (clubhouseOverrides[projectPath] ? 'on' : 'off')
    : 'global';
  const clubhouseEffective = hasClubhouseOverride
    ? clubhouseOverrides[projectPath]
    : clubhouseGlobal;
  const handleClubhouseModeChange = (value: string) => {
    if (value === 'global') clearClubhouseOverride(projectPath);
    else setClubhouseOverride(projectPath, value === 'on');
  };

  // Session name
  const sessionOverride = sessionOverrides[projectPath];
  const currentSessionMode = sessionOverride === undefined ? 'global' : (sessionOverride ? 'on' : 'off');
  const handleSessionModeChange = (value: string) => {
    if (value === 'global') clearSessionOverride(projectPath);
    else setSessionOverride(projectPath, value === 'on');
  };

  // Free agent permission mode
  const freeAgentOverride = freeAgentOverrides[projectPath];
  const currentFreeAgentMode = freeAgentOverride !== undefined ? freeAgentOverride : 'global';
  const freeAgentGlobalLabel = freeAgentGlobalMode === 'auto' ? 'Auto' : 'Skip All';
  const handleFreeAgentModeChange = (value: string) => {
    if (value === 'global') clearFreeAgentProjectMode(projectPath);
    else setFreeAgentProjectMode(projectPath, value as FreeAgentPermissionMode);
  };

  // MCP override
  const mcpOverride = mcpProjectOverrides[projectPath];
  const currentMcpMode = mcpOverride === undefined ? 'global' : (mcpOverride ? 'on' : 'off');
  const handleMcpModeChange = (value: string) => {
    const updated: Record<string, boolean> = { ...mcpProjectOverrides };
    if (value === 'global') {
      delete updated[projectPath];
    } else {
      updated[projectPath] = value === 'on';
    }
    mcpSaveSettings({ projectOverrides: Object.keys(updated).length > 0 ? updated : undefined });
  };

  return (
    <>
      {/* Project Defaults */}
      <div className="space-y-1 mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider mb-2">Project Defaults</h3>

        {/* Default Orchestrator */}
        {enabledOrchestrators.length > 1 && (
          <DefaultRow label="Default Orchestrator" description="Orchestrator for agents in this project">
            <select
              value={currentOrchestrator}
              onChange={(e) => updateProject(project.id, { orchestrator: e.target.value })}
              className={DROPDOWN_SELECT_CLASS}
            >
              {enabledOrchestrators.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </DefaultRow>
        )}

        {/* Quick Agent Mode */}
        <DefaultRow label="Quick Agent Mode" description="How quick agents spawn in this project">
          <select
            value={currentHeadlessMode}
            onChange={(e) => handleHeadlessModeChange(e.target.value)}
            className={DROPDOWN_SELECT_CLASS}
          >
            <option value="global">Global Default ({headlessDefaultMode.charAt(0).toUpperCase() + headlessDefaultMode.slice(1)})</option>
            <option value="interactive">Interactive</option>
            <option value="headless">Headless</option>
          </select>
        </DefaultRow>

        {/* Free Agent Permission Mode */}
        <DefaultRow label="Free Agent Permission Mode" description="Permission handling for agents in Free Agent mode">
          <select
            value={currentFreeAgentMode}
            onChange={(e) => handleFreeAgentModeChange(e.target.value)}
            className={DROPDOWN_SELECT_CLASS}
          >
            <option value="global">Global Default ({freeAgentGlobalLabel})</option>
            <option value="auto">Auto</option>
            <option value="skip-all">Skip All Permissions</option>
          </select>
        </DefaultRow>

        {/* Session Name on Quit */}
        <DefaultRow label="Session Name on Quit" description="Prompt to name sessions when agents stop">
          <select
            value={currentSessionMode}
            onChange={(e) => handleSessionModeChange(e.target.value)}
            className={DROPDOWN_SELECT_CLASS}
          >
            <option value="global">Global Default ({sessionPromptGlobal ? 'On' : 'Off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </DefaultRow>

        {/* Clubhouse Mode */}
        <DefaultRow label="Clubhouse Mode" description="Manage agent config centrally and push to worktrees">
          <select
            value={currentClubhouseMode}
            onChange={(e) => handleClubhouseModeChange(e.target.value)}
            className={DROPDOWN_SELECT_CLASS}
          >
            <option value="global">Global Default ({clubhouseGlobal ? 'On' : 'Off'})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </DefaultRow>

        {/* MCP Override — visible when global MCP enabled */}
        {mcpLoaded && mcpGlobalEnabled && (
          <DefaultRow label="MCP Override" description="Override MCP bridge injection for this project">
            <select
              value={currentMcpMode}
              onChange={(e) => handleMcpModeChange(e.target.value)}
              className={DROPDOWN_SELECT_CLASS}
            >
              <option value="global">Global Default ({mcpGlobalEnabled ? 'On' : 'Off'})</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </DefaultRow>
        )}
      </div>

      {/* Default Agent Settings */}
      <ProjectAgentDefaultsSection projectPath={project.path} clubhouseMode={clubhouseEffective} />
    </>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export function OrchestratorSettingsView({ projectId }: Props) {
  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Orchestrators & Agents</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          {projectId
            ? 'Configure orchestrator and agent behavior for this project.'
            : 'Configure orchestrator backends and agent behavior.'}
        </p>

        {projectId
          ? <ProjectAgentSettings projectId={projectId} />
          : <AppAgentSettings />
        }
      </div>
    </div>
  );
}
