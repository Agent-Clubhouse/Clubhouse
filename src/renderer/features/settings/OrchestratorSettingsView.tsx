import { useEffect, useId, useRef, useState } from 'react';
import { useOrchestratorStore, DEFAULT_HOOK_SERVER_ORCHESTRATOR } from '../../stores/orchestratorStore';
import { useProjectStore } from '../../stores/projectStore';
import { useHeadlessStore, SpawnMode } from '../../stores/headlessStore';
import { useSessionSettingsStore } from '../../stores/sessionSettingsStore';
import { useDefaultAccessStore } from '../../stores/defaultAccessStore';
import { Toggle } from '../../components/Toggle';
import { useUIStore } from '../../stores/uiStore';
import { resetChatFlagCache } from '../agents/chat/AgentRuntimePane';
import { RICH_CHAT_CONTENT_FLAG, resetRichChatContentFlag } from '../agents/chat/rich/rich-flag';
import { ProjectAgentDefaultsSection } from './ProjectAgentDefaultsSection';
import { effectiveOrchestratorOf } from '../agents/effective-orchestrator';
import { ManagedGitExcludesSection } from '../managed/ManagedGitExcludesSection';
import { SettingsPage, SettingsSection, SettingsField, SettingsBlock, settingsInput, settingsHelp, settingsError, SETTING_NOT_SAVED_TEXT } from './SettingsLayout';
import type { SourceControlProvider } from '../../../shared/types';
import { ACCESS_DESCRIPTIONS, ACCESS_LEVELS, accessLabel, type AccessLevel } from '../../../shared/agent-access';
import { type AgentRuntimeMode, type ChatRuntimeSettings } from '../../../shared/chat';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';
import { useChatIdleSettingsStore } from '../../stores/chatIdleSettingsStore';
import { useSourceControlSettingsStore } from '../../stores/sourceControlSettingsStore';
import { CHAT_IDLE_TIMEOUT_CHOICES } from '../../../shared/settings-definitions';

interface Props {
  projectId?: string;
}

const SELECT_CLASS = `${settingsInput} w-[200px]`;
const CODE_CLASS = 'font-mono text-ctp-subtext1';

// ── Chat view, rich content and the per-provider Chat / CLI runtime ──────

const RUNTIME_MODE_OPTIONS: Array<{ value: AgentRuntimeMode; label: string }> = [
  { value: 'chat', label: 'Chat' },
  { value: 'terminal', label: 'CLI' },
];

/** Provider default when no runtime setting is saved. */
const DEFAULT_RUNTIME_MODE: AgentRuntimeMode = 'chat';

/**
 * Loads the Chat and rich content flags and the per-provider runtime settings.
 * Saves merge into the latest stored settings so other flags and providers'
 * entries are never clobbered.
 */
function useChatRuntimeSettings() {
  const [chatEnabled, setChatEnabled] = useState(false);
  const [richChatEnabled, setRichChatEnabled] = useState(false);
  /** The flags and settings have loaded, whatever the answer. */
  const [chatResolved, setChatResolved] = useState(false);
  /** The last Chat view or Rich chat content change couldn't be saved. */
  const [flagSaveFailed, setFlagSaveFailed] = useState(false);
  const [runtimeSettings, setRuntimeSettings] = useState<ChatRuntimeSettings>({});
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeSaveFailed, setRuntimeSaveFailed] = useState<string | null>(null);
  const runtimeSavePending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Same gate as main: on unless saved off. The Copilot SDK flag reads as off outside preview builds.
        const experimental = await window.clubhouse.app.getExperimentalSettings();
        if (cancelled) return;
        setChatEnabled(isGraduatedFlagOn(experimental, 'chat'));
        setRichChatEnabled(isGraduatedFlagOn(experimental, RICH_CHAT_CONTENT_FLAG));
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

  /** Show the change, save it, and go back to what's saved if that fails. True once it's saved. */
  const saveFlag = async (key: string, on: boolean, show: (on: boolean) => void): Promise<boolean> => {
    show(on);
    setFlagSaveFailed(false);
    try {
      const current = await window.clubhouse.app.getExperimentalSettings();
      await window.clubhouse.app.saveExperimentalSettings({ ...current, [key]: on });
      return true;
    } catch {
      // telemetry-exempt: shown to the user, and the switch goes back to what's saved.
      show(!on);
      setFlagSaveFailed(true);
      return false;
    }
  };

  const setChatFlag = async (on: boolean) => {
    if (!await saveFlag('chat', on, setChatEnabled)) return;
    // Panes read the flag once. Turning on, nothing runs in chat yet, so they can read it again.
    // Turning off, they keep their answer: main decides each wake, and a live chat keeps its view until it sleeps.
    if (on) resetChatFlagCache();
  };

  const setRichChatFlag = async (on: boolean) => {
    if (!await saveFlag(RICH_CHAT_CONTENT_FLAG, on, setRichChatEnabled)) return;
    // Chat panes opened from now on read the new value.
    resetRichChatContentFlag();
  };

  // The API saves the whole provider map. Serialize this view's edits so
  // overlapping provider mode changes cannot overwrite each other's read.
  const saveRuntime = async (provider: string, change: (current: ChatRuntimeSettings) => ChatRuntimeSettings) => {
    if (runtimeSavePending.current || !chatResolved) return;
    runtimeSavePending.current = true;
    setRuntimeSaving(true); setRuntimeSaveFailed(null);
    let previous = runtimeSettings;
    setRuntimeSettings(change(previous));
    try {
      previous = (await window.clubhouse.chat.getRuntimeSettings()) ?? {};
      const next = change(previous);
      await window.clubhouse.chat.saveRuntimeSettings(next);
      if (mounted.current) setRuntimeSettings(next);
    } catch {
      // telemetry-exempt: restore the last saved values and show a retryable error.
      if (mounted.current) { setRuntimeSettings(previous); setRuntimeSaveFailed(provider); }
    } finally {
      runtimeSavePending.current = false;
      if (mounted.current) setRuntimeSaving(false);
    }
  };
  const setRuntimeMode = (provider: string, mode: AgentRuntimeMode) => saveRuntime(provider,
    (current) => ({ ...current, [provider]: { ...current[provider], mode } }));


  return { chatEnabled, richChatEnabled, chatResolved, flagSaveFailed, runtimeSaving, runtimeSaveFailed, runtimeSettings, setChatFlag, setRichChatFlag, setRuntimeMode };
}

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

function RuntimeModeControl({ value, onChange, disabled }: { value: AgentRuntimeMode; onChange: (mode: AgentRuntimeMode) => void; disabled?: boolean }) {
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
            disabled={disabled}
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
  const promptForName = useSessionSettingsStore((s) => s.promptForName);
  const setPromptForName = useSessionSettingsStore((s) => s.setPromptForName);
  const loadSessionSettings = useSessionSettingsStore((s) => s.loadSettings);
  const defaultAccess = useDefaultAccessStore((s) => s.defaultAccess);
  const setDefaultAccess = useDefaultAccessStore((s) => s.setDefaultAccess);
  const loadDefaultAccess = useDefaultAccessStore((s) => s.loadDefaultAccess);
  const { chatEnabled, richChatEnabled, chatResolved, flagSaveFailed, runtimeSaving, runtimeSaveFailed, runtimeSettings, setChatFlag, setRichChatFlag, setRuntimeMode } = useChatRuntimeSettings();
  const idleMinutes = useChatIdleSettingsStore((st) => st.idleTimeoutMinutes as number);
  const saveIdle = useChatIdleSettingsStore((st) => st.saveSettings);
  const loadIdle = useChatIdleSettingsStore((st) => st.loadSettings);
  useEffect(() => { if (chatEnabled) void loadIdle(); }, [chatEnabled, loadIdle]);
  const sourceControlProvider = useSourceControlSettingsStore((st) => st.provider);
  const loadSourceControl = useSourceControlSettingsStore((st) => st.loadSettings);
  const saveSourceControl = useSourceControlSettingsStore((st) => st.saveSettings);
  useEffect(() => { void loadSourceControl(); }, [loadSourceControl]);
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
    loadSessionSettings();
    void loadDefaultAccess();
  }, [loadSettings, checkAllAvailability, loadSessionSettings, loadDefaultAccess]);

  return (
    <>
      <SettingsSection title="Access">
        <SettingsField
          label="Default access"
          help={`The level new agents and quick agents start at. A CLI without it starts at the nearest lower level. ${ACCESS_DESCRIPTIONS[defaultAccess]}`}
          htmlFor={`${idBase}-default-access`}
        >
          <select
            id={`${idBase}-default-access`}
            value={defaultAccess}
            onChange={(e) => { void setDefaultAccess(e.target.value as AccessLevel); }}
            className={SELECT_CLASS}
            data-testid="app-default-access"
          >
            {ACCESS_LEVELS.map((level) => <option key={level} value={level}>{accessLabel(level)}</option>)}
          </select>
        </SettingsField>
      </SettingsSection>

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
      </SettingsSection>

      <SettingsSection title="Durable agents">
        <SettingsField
          label="Prompt for session name on quit"
          help="Ask to name the session when a durable agent stops. Projects can override this."
        >
          <Toggle aria-label="Prompt for session name on quit" checked={promptForName} onChange={setPromptForName} />
        </SettingsField>
        <SettingsField
          label="Source control provider"
          help={<>Fills <code className={CODE_CLASS}>@@SourceControlProvider</code> for agents that aren’t Clubhouse-managed, when their project and own settings don’t set one.</>}
          htmlFor={`${idBase}-source-control`}
        >
          <select
            id={`${idBase}-source-control`}
            value={sourceControlProvider ?? 'github'}
            onChange={(e) => { void saveSourceControl({ provider: e.target.value as SourceControlProvider }); }}
            className={SELECT_CLASS}
            data-testid="app-source-control-provider"
          >
            <option value="github">GitHub (gh CLI)</option>
            <option value="azure-devops">Azure DevOps (az CLI)</option>
          </select>
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

      {chatResolved && (
        <SettingsSection title="Chat">
          <SettingsField
            label="Chat view"
            help="Agents open in a native chat view. Turn this off to run every agent in the CLI view, whatever its provider or its own setting says. Agents already running stay as they are until they sleep."
            testId="chat-view-row"
          >
            <Toggle aria-label="Chat view" checked={chatEnabled} onChange={(on) => { void setChatFlag(on); }} />
          </SettingsField>
          <SettingsField
            label="Rich chat content"
            help="Show images agents return inline in chat, links as links, file chips with previews, and GitHub pull requests, issues and commits as references with a hover card. Images from the web load only when you click them, and GitHub details load through the gh CLI only when you hover one. While this is on, paired phones (Clubhouse Go) can also read any file your user account can read on this computer, up to a size limit. Chats opened after a change use the new setting."
            testId="rich-chat-content-row"
          >
            <Toggle aria-label="Rich chat content" checked={richChatEnabled} onChange={(on) => { void setRichChatFlag(on); }} />
          </SettingsField>
          {flagSaveFailed && (
            <SettingsBlock>
              <p className={settingsError} role="alert">{SETTING_NOT_SAVED_TEXT}</p>
            </SettingsBlock>
          )}
        </SettingsSection>
      )}

      <SettingsSection title="Agent providers">
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
            : isOnlyEnabled && !notInstalled ? 'At least one agent provider must be enabled' : undefined;
          // The sub-rows only render when the orchestrator is enabled. The
          // hook server option shows only for hook-capable orchestrators, the
          // runtime option only with Chat on. Resolve the
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
                          disabled={runtimeSaving || !chatResolved}
                          onChange={(mode) => setRuntimeMode(o.id, mode)}
                        />
                      </SettingsField>
                      {runtimeSaveFailed === o.id && <p role="alert" className={settingsError}>{SETTING_NOT_SAVED_TEXT}</p>}

                    </div>
                  )}
                  {hookCapable && (
                    <SettingsField
                      label="Hook server"
                      help="Receives terminal hook callbacks, like permission requests and tool events. Chat uses its runtime protocol for status and approvals. Running agents need a restart for the change to take full effect."
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
            <p className={settingsHelp}>No agent providers registered.</p>
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

  const sessionPromptGlobal = useSessionSettingsStore((s) => s.promptForName);
  const sessionOverrides = useSessionSettingsStore((s) => s.projectOverrides);
  const setSessionOverride = useSessionSettingsStore((s) => s.setProjectOverride);
  const clearSessionOverride = useSessionSettingsStore((s) => s.clearProjectOverride);
  const loadSessionSettings = useSessionSettingsStore((s) => s.loadSettings);

  useEffect(() => {
    loadSessionSettings();
  }, [loadSessionSettings]);

  if (!project) return null;

  const projectPath = project.path;
  // The same rule main and every CLI label use (#2975).
  const currentOrchestrator = effectiveOrchestratorOf({}, project, allOrchestrators);

  // Headless mode
  const hasHeadlessOverride = projectPath in headlessOverrides;
  const currentHeadlessMode = hasHeadlessOverride ? headlessOverrides[projectPath] : 'global';
  const handleHeadlessModeChange = (value: string) => {
    if (value === 'global') clearProjectMode(projectPath);
    else setProjectMode(projectPath, value as SpawnMode);
  };

  // Session name
  const sessionOverride = sessionOverrides[projectPath];
  const currentSessionMode = sessionOverride === undefined ? 'global' : (sessionOverride ? 'on' : 'off');
  const handleSessionModeChange = (value: string) => {
    if (value === 'global') clearSessionOverride(projectPath);
    else setSessionOverride(projectPath, value === 'on');
  };

  const onOff = (v: boolean) => (v ? 'On' : 'Off');

  return (
    <>
      <SettingsSection title="Project environment">
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
      </SettingsSection>

      <ProjectAgentDefaultsSection projectPath={project.path} />
      <ManagedGitExcludesSection projectPath={project.path} />
    </>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export function OrchestratorSettingsView({ projectId }: Props) {
  return (
    <SettingsPage
      title="Agents & providers"
      description={projectId
        ? 'Configure the agent provider and agent behavior for this project.'
        : 'Configure agent providers and agent behavior.'}
    >
      {projectId
        ? <ProjectAgentSettings projectId={projectId} />
        : <AppAgentSettings />
      }
    </SettingsPage>
  );
}
