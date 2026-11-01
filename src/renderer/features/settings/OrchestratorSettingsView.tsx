import { useEffect, useId, useRef, useState } from 'react';
import { useOrchestratorStore, DEFAULT_HOOK_SERVER_ORCHESTRATOR } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore, SpawnMode } from '../../stores/headlessStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';
import { useMcpSettingsStore } from '../../stores/mcpSettingsStore';
import { useFreeAgentSettingsStore } from '../../stores/freeAgentSettingsStore';
import { Toggle } from '../../components/Toggle';
import { Modal } from '../../components/Modal';
import { useUIStore } from '../../stores/uiStore';
import { noteExplicitTerminalChoice } from '../agents/chat/chat-default-tip';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsInput, settingsHelp } from './SettingsLayout';
import type { FreeAgentPermissionMode, SourceControlProvider } from '../../../shared/types';
import type { AgentRuntimeMode, ChatDriverId, ChatRuntimeSettings } from '../../../shared/chat';
import { Button } from '../../components/Button';
import { useChatIdleSettingsStore } from '../../stores/chatIdleSettingsStore';
import { CHAT_IDLE_TIMEOUT_CHOICES } from '../../../shared/settings-definitions';

interface Props {
  projectId?: string;
}

const CLUBHOUSE_WILDCARDS = [
  '@@AgentName', '@@StandbyBranch', '@@Path', '@@SourceControlProvider',
  '@@BuildCommand', '@@TestCommand', '@@LintCommand', '@@Mission', '@@Persona',
];

const SELECT_CLASS = `${settingsInput} w-[200px]`;
const CODE_CLASS = 'font-mono text-ctp-subtext1';

// ── Per-provider Chat / CLI runtime (experimental 'chat' flag) ──────

const RUNTIME_MODE_OPTIONS: Array<{ value: AgentRuntimeMode; label: string }> = [
  { value: 'chat', label: 'Chat' },
  { value: 'terminal', label: 'CLI' },
];

/** Provider default when no runtime setting is saved. */
const DEFAULT_RUNTIME_MODE: AgentRuntimeMode = 'chat';

/**
 * Loads the experimental Chat flag and, when it's on, the per-provider
 * runtime settings. Saves merge into the latest stored settings so other
 * providers' entries are never clobbered.
 */
function useChatRuntimeSettings() {
  const [chatEnabled, setChatEnabled] = useState(false);
  /** The flag (and, when on, the settings) have loaded, whatever the answer. */
  const [chatResolved, setChatResolved] = useState(false);
  const [runtimeSettings, setRuntimeSettings] = useState<ChatRuntimeSettings>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Same gate as main: the flag only counts in preview-eligible builds.
        const [experimental, eligible] = await Promise.all([
          window.clubhouse.app.getExperimentalSettings(),
          window.clubhouse.app.isPreviewEligible(),
        ]);
        if (cancelled || experimental?.chat !== true || !eligible) return;
        setChatEnabled(true);
        const settings = await window.clubhouse.chat.getRuntimeSettings();
        if (!cancelled) setRuntimeSettings(settings ?? {});
      } catch {
        // Leave the control hidden / at defaults.
      } finally {
        if (!cancelled) setChatResolved(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const setRuntimeMode = async (orchestratorId: string, mode: AgentRuntimeMode) => {
    // An explicit CLI choice means the "Agents now open in Chat" tip is never needed.
    if (mode === 'terminal') noteExplicitTerminalChoice();
    setRuntimeSettings((prev) => ({ ...prev, [orchestratorId]: { ...prev[orchestratorId], mode } }));
    try {
      const current = (await window.clubhouse.chat.getRuntimeSettings()) ?? {};
      await window.clubhouse.chat.saveRuntimeSettings({
        ...current,
        [orchestratorId]: { ...current[orchestratorId], mode },
      });
    } catch {
      // Best-effort; the optimistic value stays until the next load.
    }
  };

  const setChatDriver = async (orchestratorId: string, mode: AgentRuntimeMode, driver: ChatDriverId | undefined) => {
    const withDriver = (prev: ChatRuntimeSettings): ChatRuntimeSettings => {
      const { driver: _old, ...rest } = prev[orchestratorId] ?? { mode };
      return { ...prev, [orchestratorId]: { ...rest, mode: rest.mode ?? mode, ...(driver && { driver }) } };
    };
    setRuntimeSettings(withDriver);
    try {
      await window.clubhouse.chat.saveRuntimeSettings(withDriver((await window.clubhouse.chat.getRuntimeSettings()) ?? {}));
    } catch {
      // Best-effort; the optimistic value stays until the next load.
    }
  };

  return { chatEnabled, chatResolved, runtimeSettings, setRuntimeMode, setChatDriver };
}

/** Chat drivers a provider lets you choose between. The first is what it gets when nothing is chosen. */
const CHAT_DRIVER_CHOICES: Readonly<Record<string, ReadonlyArray<{ value: ChatDriverId; label: string }>>> = {
  'copilot-cli': [
    { value: 'copilot_acp', label: 'ACP (default)' },
    { value: 'copilot_sdk', label: 'Copilot SDK (experimental)' },
  ],
};

/** The offered choices, plus a hand-edited value that isn't one of them, so the select shows it. */
function idleChoices(current: number): number[] {
  const choices: number[] = [...CHAT_IDLE_TIMEOUT_CHOICES];
  if (Number.isFinite(current) && current > 0 && !choices.includes(current)) {
    choices.splice(choices.findIndex((m) => m === 0 || m > current), 0, current);
  }
  return choices;
}

function idleChoiceLabel(minutes: number): string {
  if (minutes <= 0) return 'Never';
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  return `${minutes} minutes`;
}

function RuntimeModeControl({ value, onChange }: { value: AgentRuntimeMode; onChange: (mode: AgentRuntimeMode) => void }) {
  return (
    <div role="radiogroup" aria-label="Runtime" className="flex h-7 p-0.5 gap-0.5 rounded-md border border-surface-1">
      {RUNTIME_MODE_OPTIONS.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => { if (!selected) onChange(opt.value); }}
            className={`px-2 rounded text-xs cursor-pointer transition-colors ${
              selected ? 'bg-surface-1 text-ctp-text' : 'text-ctp-overlay1 hover:text-ctp-text'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ── App-level: global headless toggle + orchestrator enable/disable ──────

function AppAgentSettings() {
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const availability = useOrchestratorStore((s) => s.availability);
  const loadSettings = useOrchestratorStore((s) => s.loadSettings);
  const setEnabled = useOrchestratorStore((s) => s.setEnabled);
  const setHookServerEnabled = useOrchestratorStore((s) => s.setHookServerEnabled);
  // Subscribe to the raw prefs map so rows re-render when a hook pref flips.
  const hookServerPrefs = useOrchestratorStore((s) => s.hookServerEnabled);
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
  const { chatEnabled, chatResolved, runtimeSettings, setRuntimeMode, setChatDriver } = useChatRuntimeSettings();
  const idleMinutes = useChatIdleSettingsStore((st) => st.idleTimeoutMinutes as number);
  const saveIdle = useChatIdleSettingsStore((st) => st.saveSettings);
  const loadIdle = useChatIdleSettingsStore((st) => st.loadSettings);
  useEffect(() => { if (chatEnabled) void loadIdle(); }, [chatEnabled, loadIdle]);
  const idBase = useId();

  // Deep link (uiStore.openRuntimeSettings): scroll to the provider's runtime
  // row and outline it briefly. Falls back to the provider's row when the
  // runtime row isn't shown (provider disabled). The focus is one-shot: it's
  // cleared once used, when there's nothing to scroll to (chat off, unknown
  // provider) and when this page unmounts, so it can't fire on a later visit.
  const settingsFocus = useUIStore((s) => s.settingsFocus);
  const setSettingsFocus = useUIStore((s) => s.setSettingsFocus);
  const runtimeRowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [highlightedRuntime, setHighlightedRuntime] = useState<string | null>(null);
  useEffect(() => {
    if (!settingsFocus?.startsWith('runtime:') || !chatResolved) return;
    if (!chatEnabled) {
      setSettingsFocus(null);
      return;
    }
    const providerId = settingsFocus.slice('runtime:'.length);
    const target = runtimeRowRefs.current[providerId] ?? cardRefs.current[providerId];
    if (!target) {
      // Rows not rendered yet: retried when the orchestrator list arrives. Once
      // it has, a missing target means an unknown provider.
      if (allOrchestrators.length > 0) setSettingsFocus(null);
      return;
    }
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    setHighlightedRuntime(providerId);
    setSettingsFocus(null);
  }, [settingsFocus, chatEnabled, chatResolved, allOrchestrators, enabled, setSettingsFocus]);
  useEffect(() => () => {
    if (useUIStore.getState().settingsFocus?.startsWith('runtime:')) useUIStore.getState().setSettingsFocus(null);
  }, []);
  useEffect(() => {
    if (!highlightedRuntime) return;
    const t = setTimeout(() => setHighlightedRuntime(null), 2500);
    return () => clearTimeout(t);
  }, [highlightedRuntime]);

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
      <SettingsSection title="Quick agents">
        <SettingsField
          label="Default quick agent mode"
          help="How quick agents run. Headless is faster and gives richer summaries."
          htmlFor={`${idBase}-quick-mode`}
        >
          <select
            id={`${idBase}-quick-mode`}
            value={defaultMode}
            onChange={(e) => setDefaultMode(e.target.value as SpawnMode)}
            className={SELECT_CLASS}
          >
            <option value="interactive">Interactive</option>
            <option value="headless">Headless</option>
          </select>
        </SettingsField>
        <SettingsField
          label="Free agent permission mode"
          help={<>Skip all bypasses every check. Auto uses a safety classifier and needs <code className={CODE_CLASS}>--permission-mode</code> support in your CLI.</>}
          htmlFor={`${idBase}-free-mode`}
        >
          <select
            id={`${idBase}-free-mode`}
            value={freeAgentDefaultMode}
            onChange={(e) => setFreeAgentDefaultMode(e.target.value as FreeAgentPermissionMode)}
            className={SELECT_CLASS}
          >
            <option value="skip-all">Skip all permissions (default)</option>
            <option value="auto">Auto (requires CLI support)</option>
          </select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Durable agents">
        <SettingsField
          label="Clubhouse Mode"
          help="Manage agent instructions, permissions and MCP config in one place. Clubhouse pushes them to worktrees when an agent wakes."
          testId="clubhouse-mode-row"
        >
          <Toggle aria-label="Clubhouse Mode" checked={clubhouseEnabled} onChange={handleClubhouseToggle} />
        </SettingsField>
        {clubhouseEnabled && (
          <SettingsBlock>
            <p className={settingsHelp}>
              Project defaults can use these wildcards, resolved for each agent when it wakes.
            </p>
            <p className="text-xs mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
              {CLUBHOUSE_WILDCARDS.map((w) => <code key={w} className={CODE_CLASS}>{w}</code>)}
            </p>
            <p className={`${settingsHelp} mt-1.5`}>
              Each project with Clubhouse Mode on gets a self-edit guide at <code className={CODE_CLASS}>.clubhouse/clubhouse-mode.md</code> that covers every setting on disk.
            </p>
          </SettingsBlock>
        )}
        {clubhouseEnabled && (
          <SettingsField
            label="Default source control provider"
            help="Used by every project unless it sets its own."
            htmlFor={`${idBase}-scp`}
          >
            <select
              id={`${idBase}-scp`}
              value={clubhouseScp}
              onChange={(e) => setClubhouseScp(e.target.value as SourceControlProvider)}
              className={SELECT_CLASS}
            >
              <option value="github">GitHub (gh CLI)</option>
              <option value="azure-devops">Azure DevOps (az CLI)</option>
            </select>
          </SettingsField>
        )}
        <SettingsField
          label="Prompt for session name on quit"
          help="Ask to name the session when a durable agent stops. Projects can override this."
        >
          <Toggle aria-label="Prompt for session name on quit" checked={promptForName} onChange={setPromptForName} />
        </SettingsField>
        {chatEnabled && (
          <SettingsField
            label="Sleep idle chat agents after"
            help="A chat agent with no turn for this long goes to sleep. An agent can set its own in its Session details. Agents in a group project with polling on stay awake."
            htmlFor={`${idBase}-chat-idle`}
          >
            <select
              id={`${idBase}-chat-idle`}
              value={String(idleMinutes)}
              onChange={(e) => { void saveIdle({ idleTimeoutMinutes: Number(e.target.value) }); }}
              className={SELECT_CLASS}
              data-testid="chat-idle-timeout"
            >
              {idleChoices(idleMinutes).map((m) => (
                <option key={m} value={m}>{idleChoiceLabel(m)}</option>
              ))}
            </select>
          </SettingsField>
        )}
      </SettingsSection>

      <Modal open={showConfirm} onClose={() => setShowConfirm(false)} title="Enable Clubhouse Mode?" width="w-[420px] max-w-[calc(100vw-32px)]" testId="clubhouse-mode-confirm" footer={
        <>
          <Button onClick={() => setShowConfirm(false)} kind="ghost">
            Cancel
          </Button>
          <Button onClick={confirmEnable} kind="primary">
            Enable
          </Button>
        </>
      }>
        <div>
          <p className={`${settingsHelp} mb-2`}>
            This will overwrite agent settings in worktrees with project-level defaults each time an agent wakes.
            Commit or back up your current agent configurations first.
          </p>
          <p className={settingsHelp}>
            Projects without defaults get starter templates that use wildcards.
          </p>
        </div>
      </Modal>

      <SettingsSection title="Orchestrators">
        {allOrchestrators.map((o) => {
          const isEnabled = enabled.includes(o.id);
          const avail = availability[o.id];
          const isOnlyEnabled = isEnabled && enabled.length === 1;
          const notInstalled = avail && !avail.available;
          // Allow turning OFF a not-installed orchestrator; only block:
          // 1. turning ON something not installed
          // 2. turning OFF the last working (available) orchestrator
          const toggleDisabled = (isOnlyEnabled && !notInstalled) || (!!notInstalled && !isEnabled);
          const toggleTitle = !!notInstalled && !isEnabled
            ? 'CLI not found. Install it to enable.'
            : isOnlyEnabled && !notInstalled ? 'At least one orchestrator must be enabled' : undefined;
          // The sub-rows only render when the orchestrator is enabled. The
          // hook server option shows only for hook-capable orchestrators, the
          // runtime option only with the experimental Chat flag. Resolve the
          // effective hook pref reactively from the subscribed prefs map.
          const hookCapable = !!o.capabilities?.hooks;
          const showExpansion = isEnabled && (hookCapable || chatEnabled);
          const hookServerOn = hookServerPrefs[o.id] ?? (o.id === DEFAULT_HOOK_SERVER_ORCHESTRATOR);
          const runtimeMode = runtimeSettings[o.id]?.mode ?? DEFAULT_RUNTIME_MODE;
          const statusWord = avail?.available ? 'Installed' : avail ? 'Not found' : 'Checking';

          return (
            <div key={o.id} ref={(el) => { cardRefs.current[o.id] = el; }} data-testid={`orchestrator-row-${o.id}`}>
              <SettingsField
                label={
                  <span className="flex items-baseline gap-2">
                    <span>{o.displayName}</span>
                    <span className="text-xs text-ctp-overlay1 inline-flex items-center gap-1.5">
                      <span
                        className={`inline-block w-2 h-2 rounded-full self-center ${
                          avail?.available ? 'bg-ctp-success' : avail ? 'bg-ctp-error' : 'bg-ctp-overlay0'
                        }`}
                        title={avail?.available ? 'CLI found' : avail?.error || 'Checking...'}
                      />
                      {statusWord}
                      {o.badge && <span>· {o.badge}</span>}
                    </span>
                  </span>
                }
                help={avail && !avail.available && avail.error ? avail.error : undefined}
              >
                <span title={toggleTitle} data-testid={`orchestrator-toggle-${o.id}`}>
                  <Toggle
                    aria-label={o.displayName}
                    checked={isEnabled}
                    onChange={(v) => setEnabled(o.id, v)}
                    disabled={toggleDisabled}
                  />
                </span>
              </SettingsField>

              {showExpansion && (
                <div className="pl-5">
                  {chatEnabled && (
                    <div
                      ref={(el) => { runtimeRowRefs.current[o.id] = el; }}
                      className={`rounded-md transition-[outline-color] ${
                        highlightedRuntime === o.id ? 'outline outline-1 outline-offset-2 outline-ctp-accent' : 'outline-transparent'
                      }`}
                      data-testid={`runtime-mode-${o.id}`}
                      data-highlighted={highlightedRuntime === o.id ? 'true' : undefined}
                    >
                      <SettingsField
                        label="Runtime"
                        help="Agents for this provider open in chat. Choose CLI to use the provider's own interface. Chat needs a supported CLI; until then agents open in the CLI view."
                      >
                        <RuntimeModeControl
                          value={runtimeMode}
                          onChange={(mode) => setRuntimeMode(o.id, mode)}
                        />
                      </SettingsField>
                      {runtimeMode === 'chat' && CHAT_DRIVER_CHOICES[o.id] && (
                        <SettingsField
                          label="Chat driver"
                          help="How chat talks to the CLI. Applies the next time an agent starts, and the chat says when it runs on the Copilot SDK. If the SDK can't start, the agent uses ACP and tells you why."
                          htmlFor={`${idBase}-driver-${o.id}`}
                        >
                          <select
                            id={`${idBase}-driver-${o.id}`}
                            data-testid={`chat-driver-${o.id}`}
                            value={runtimeSettings[o.id]?.driver ?? CHAT_DRIVER_CHOICES[o.id][0].value}
                            onChange={(e) => {
                              const value = e.target.value as ChatDriverId;
                              void setChatDriver(o.id, runtimeMode, value === CHAT_DRIVER_CHOICES[o.id][0].value ? undefined : value);
                            }}
                            className={SELECT_CLASS}
                          >
                            {CHAT_DRIVER_CHOICES[o.id].map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                          </select>
                        </SettingsField>
                      )}
                    </div>
                  )}
                  {hookCapable && (
                    <SettingsField
                      label="Hook server"
                      help="Receives this orchestrator's hook callbacks, like permission requests and tool events. When off, its agents get no hooks, so remote permissions and observability stop working. Running agents need a restart for the change to take full effect."
                    >
                      <Toggle
                        aria-label={`Hook server for ${o.displayName}`}
                        checked={hookServerOn}
                        onChange={(v) => setHookServerEnabled(o.id, v)}
                      />
                    </SettingsField>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {allOrchestrators.length === 0 && (
          <SettingsBlock>
            <p className={settingsHelp}>No orchestrators registered.</p>
          </SettingsBlock>
        )}
      </SettingsSection>
    </>
  );
}

// ── Project-level: unified project defaults ─────────────────────────────

function ProjectAgentSettings({ projectId }: { projectId: string }) {
  const { projects, updateProject } = useProjectStore();
  const project = projects.find((p) => p.id === projectId);
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));
  const idBase = useId();

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
  const freeAgentGlobalLabel = freeAgentGlobalMode === 'auto' ? 'Auto' : 'Skip all';
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

  const onOff = (v: boolean) => (v ? 'On' : 'Off');

  return (
    <>
      <SettingsSection title="Project defaults">
        {enabledOrchestrators.length > 1 && (
          <SettingsField label="Agents run on" help="The CLI new agents in this project run on." htmlFor={`${idBase}-orch`}>
            <select
              id={`${idBase}-orch`}
              value={currentOrchestrator}
              onChange={(e) => updateProject(project.id, { orchestrator: e.target.value })}
              className={SELECT_CLASS}
            >
              {enabledOrchestrators.map((o) => (
                <option key={o.id} value={o.id}>{o.displayName}</option>
              ))}
            </select>
          </SettingsField>
        )}

        <SettingsField label="Quick agent mode" help="How quick agents start in this project." htmlFor={`${idBase}-quick`}>
          <select
            id={`${idBase}-quick`}
            value={currentHeadlessMode}
            onChange={(e) => handleHeadlessModeChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="global">Global default ({headlessDefaultMode.charAt(0).toUpperCase() + headlessDefaultMode.slice(1)})</option>
            <option value="interactive">Interactive</option>
            <option value="headless">Headless</option>
          </select>
        </SettingsField>

        <SettingsField label="Free agent permission mode" help="How agents in Free Agent mode handle permissions." htmlFor={`${idBase}-free`}>
          <select
            id={`${idBase}-free`}
            value={currentFreeAgentMode}
            onChange={(e) => handleFreeAgentModeChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="global">Global default ({freeAgentGlobalLabel})</option>
            <option value="auto">Auto</option>
            <option value="skip-all">Skip all permissions</option>
          </select>
        </SettingsField>

        <SettingsField label="Session name on quit" help="Ask to name the session when an agent stops." htmlFor={`${idBase}-session`}>
          <select
            id={`${idBase}-session`}
            value={currentSessionMode}
            onChange={(e) => handleSessionModeChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="global">Global default ({onOff(sessionPromptGlobal)})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </SettingsField>

        <SettingsField label="Clubhouse Mode" help="Manage agent config in one place and push it to worktrees." htmlFor={`${idBase}-clubhouse`}>
          <select
            id={`${idBase}-clubhouse`}
            value={currentClubhouseMode}
            onChange={(e) => handleClubhouseModeChange(e.target.value)}
            className={SELECT_CLASS}
          >
            <option value="global">Global default ({onOff(clubhouseGlobal)})</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </SettingsField>

        {/* MCP override, shown when the app-wide MCP bridge is on */}
        {mcpLoaded && mcpGlobalEnabled && (
          <SettingsField label="MCP override" help="Override MCP bridge injection for this project." htmlFor={`${idBase}-mcp`}>
            <select
              id={`${idBase}-mcp`}
              value={currentMcpMode}
              onChange={(e) => handleMcpModeChange(e.target.value)}
              className={SELECT_CLASS}
            >
              <option value="global">Global default ({onOff(mcpGlobalEnabled)})</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </SettingsField>
        )}
      </SettingsSection>

      <ProjectAgentDefaultsSection projectPath={project.path} clubhouseMode={clubhouseEffective} />
    </>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export function OrchestratorSettingsView({ projectId }: Props) {
  return (
    <SettingsPage
      title="Orchestrators & agents"
      description={projectId
        ? 'Configure orchestrator and agent behavior for this project.'
        : 'Configure orchestrator backends and agent behavior.'}
    >
      {projectId
        ? <ProjectAgentSettings projectId={projectId} />
        : <AppAgentSettings />
      }
    </SettingsPage>
  );
}
