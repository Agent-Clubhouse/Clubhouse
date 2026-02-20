import { useEffect } from 'react';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore, SpawnMode } from '../../stores/headlessStore';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';

interface Props {
  projectId?: string;
}

// ── App-level: global headless toggle + orchestrator enable/disable ──────

function AppAgentSettings() {
  const { enabled, allOrchestrators, availability, loadSettings, setEnabled, checkAllAvailability } =
    useOrchestratorStore();
  const headlessEnabled = useHeadlessStore((s) => s.enabled);
  const setHeadlessEnabled = useHeadlessStore((s) => s.setEnabled);

  useEffect(() => {
    loadSettings().then(() => checkAllAvailability());
  }, [loadSettings, checkAllAvailability]);

  return (
    <>
      {/* Headless Quick Agents toggle */}
      <div className="space-y-3 mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Quick Agents</h3>
        <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-ctp-mantle border border-surface-0">
          <div className="flex items-center gap-2.5">
            <span className="text-ctp-subtext1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            </span>
            <div>
              <div className="text-sm text-ctp-text">Headless Mode</div>
              <div className="text-xs text-ctp-subtext0 mt-0.5">
                Quick agents run headless by default for faster completion, richer summaries, and no permission prompts
              </div>
            </div>
          </div>
          <button
            onClick={() => setHeadlessEnabled(!headlessEnabled)}
            className="toggle-track"
            data-on={String(headlessEnabled)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
      </div>

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

// ── Project-level: orchestrator picker + quick agent mode ────────────────

function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

  const headlessGlobal = useHeadlessStore((s) => s.enabled);
  const projectOverrides = useHeadlessStore((s) => s.projectOverrides);
  const setProjectMode = useHeadlessStore((s) => s.setProjectMode);
  const clearProjectMode = useHeadlessStore((s) => s.clearProjectMode);

  if (!project) return null;

  const projectPath = project.path;
  const hasOverride = projectPath in projectOverrides;
  const currentMode = hasOverride ? projectOverrides[projectPath] : 'global';
  const currentOrchestrator = project.orchestrator || 'claude-code';

  const handleModeChange = (value: string) => {
    if (value === 'global') clearProjectMode(projectPath);
    else setProjectMode(projectPath, value as SpawnMode);
  };

  return (
    <>
      {/* Orchestrator picker */}
      {enabledOrchestrators.length > 1 && (
        <div className="space-y-2 mb-6">
          <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Orchestrator</h3>
          <select
            value={currentOrchestrator}
            onChange={(e) => updateProject(project.id, { orchestrator: e.target.value })}
            className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          >
            {enabledOrchestrators.map((o) => (
              <option key={o.id} value={o.id}>{o.displayName}</option>
            ))}
          </select>
          <p className="text-xs text-ctp-subtext0">
            Default orchestrator for agents in this project. Individual agents can override.
          </p>
        </div>
      )}

      {/* Default Agent Settings */}
      <ProjectAgentDefaultsSection projectPath={project.path} />

      {/* Quick agent mode */}
      <div className="space-y-2 mb-6">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">Quick Agent Mode</h3>
        <select
          value={currentMode}
          onChange={(e) => handleModeChange(e.target.value)}
          className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
            text-ctp-text focus:outline-none focus:border-ctp-accent/50"
        >
          <option value="global">Global Default ({headlessGlobal ? 'Headless' : 'Interactive'})</option>
          <option value="headless">Headless</option>
          <option value="interactive">Interactive</option>
        </select>
        <p className="text-xs text-ctp-subtext0">
          How quick agents spawn in this project. Headless runs faster with richer summaries.
        </p>
      </div>
    </>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export function OrchestratorSettingsView({ projectId }: Props) {
  return (
    <div className="h-full overflow-y-auto bg-ctp-base p-6">
      <div className="max-w-2xl">
        <h2 className="text-lg font-semibold text-ctp-text mb-1">Agents</h2>
        <p className="text-sm text-ctp-subtext0 mb-6">
          {projectId
            ? 'Configure agent behavior for this project.'
            : 'Configure agent backends and behavior.'}
        </p>

        {projectId
          ? <ProjectAgentSettings projectId={projectId} />
          : <AppAgentSettings />
        }
      </div>
    </div>
  );
}
