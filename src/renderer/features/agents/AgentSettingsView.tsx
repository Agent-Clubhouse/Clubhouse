import { useEffect, useMemo, useState, useRef } from 'react';
import { Agent, QuickAgentDefaults, McpCatalogArg, McpCatalogEntry, McpCatalogEntryWithState } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useContextWindowOptions } from '../../hooks/useContextWindowOptions';
import { ContextWindowSelect, contextWindowHelp, formatContextChoice } from './ContextWindowField';
import { useEffectiveOrchestrators } from '../../hooks/useEffectiveOrchestrators';
import { buildOrchestratorOptions } from './orchestrator-options';
import { useCliChangeConfirm } from './useCliChangeConfirm';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { HandshakeRetry } from './HandshakeRetry';
import { UtilityTerminal } from './UtilityTerminal';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { EmojiPicker } from '../../components/EmojiPicker';
import { SkillsSection } from './SkillsSection';
import { AgentTemplatesSection } from './AgentTemplatesSection';
import { McpJsonSection } from './McpJsonSection';
import { AgentAvatar } from './AgentAvatar';
import { TemplateConfigDialog, type TemplateConfig } from './TemplateConfigDialog';
import type { RegisteredPluginAgentTemplate } from '../../plugins/plugin-agent-template-registry';
import type { AgentRuntimeMode } from '../../../shared/chat';
import { Toggle } from '../../components/Toggle';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { useToastStore } from '../../stores/toastStore';
import { reportChromeActionFailed } from '../../chrome/telemetry';
import { useChromeFlagStore } from '../../chrome/chromeFlag';
import {
  AGENT_SETTINGS_PAGES,
  useAgentSettingsPages,
  type AgentSettingsPage,
  requestCloseAgentSettings,
  hiddenAgentSettingsPages,
  type SaveHandle,
} from './agentSettingsPages';
import { isRemoteProjectId } from '../../stores/remoteProjectStore';
import { Field, FieldLabel, inputClass, PageTitle, SectionHeading, selectClass, textareaClass } from './agentSettingsUi';
import { AgentHelpersSettings } from './helpers/AgentHelpersSettings';
import { isGraduatedFlagOn } from '../../../shared/graduated-flags';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { ManagedBuilder, PreviewPane } from '../managed/ManagedBuilder';
import { ManagedGeneralSection } from '../managed/ManagedGeneralSection';
import { legacyUse } from '../managed/legacy';
import { isDispatcherAgent } from '../dispatcher/dispatcherStore';

interface Props {
  agent: Agent;
}

/** Catalog diff states as plain colored words (#2015). */
const MCP_STATE_WORD: Partial<Record<McpCatalogEntryWithState['state'], { word: string; className: string }>> = {
  new: { word: 'new', className: 'text-ctp-success' },
  changed: { word: 'changed', className: 'text-ctp-warning' },
  removed: { word: 'removed', className: 'text-ctp-error' },
};

function McpConfigRow({
  entry,
  checked,
  configs,
  disabled,
  onToggle,
  onConfigChange,
}: {
  entry: McpCatalogEntryWithState;
  checked: boolean;
  configs: Record<string, string>;
  disabled?: boolean;
  onToggle: () => void;
  onConfigChange: (flag: string, value: string) => void;
}) {
  const hasArgs = entry.args && entry.args.length > 0;
  const [expanded, setExpanded] = useState(false);
  const isRemoved = entry.state === 'removed';
  const stateWord = MCP_STATE_WORD[entry.state];

  // Detect boolean flags by description heuristic: render them as toggles, not text inputs.
  const isBooleanFlag = (a: McpCatalogArg) =>
    !a.description || /^(enable|disable|force|use)\b/i.test(a.description);
  const booleanArgs = (entry.args || []).filter(isBooleanFlag);
  const textArgs = (entry.args || []).filter((a) => !isBooleanFlag(a));

  return (
    <div className="border-t border-surface-0">
      <div className={`h-[30px] flex items-center gap-2 ${isRemoved ? 'opacity-70' : ''}`}>
        <label className="flex items-center gap-2 flex-1 cursor-pointer min-w-0" title={entry.description}>
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            disabled={disabled}
            className="w-3.5 h-3.5 rounded accent-ctp-accent shrink-0"
          />
          <span className="text-[13px] text-ctp-text truncate">{entry.name}</span>
          {stateWord && <span className={`text-xs ${stateWord.className}`}>{stateWord.word}</span>}
        </label>
        {hasArgs && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            aria-label={`Parameters for ${entry.name}`}
            className="w-7 h-7 rounded-md flex items-center justify-center text-ctp-overlay1 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
      {expanded && hasArgs && (
        <div className="ml-6 mb-2 space-y-1.5">
          {textArgs.map((arg) => (
            <div key={arg.name} className="flex items-center gap-2">
              <span className="text-xs text-ctp-overlay1 font-mono w-28 text-right shrink-0 flex items-center justify-end gap-1">
                {arg.required && <span className="w-1 h-1 rounded-full bg-ctp-warning inline-block" role="img" aria-label="Required" />}
                {arg.name.replace(/^--/, '')}
              </span>
              <input
                type="text"
                value={configs[arg.name] || ''}
                onChange={(e) => onConfigChange(arg.name, e.target.value)}
                placeholder={arg.description || ''}
                disabled={disabled}
                className={`flex-1 ${inputClass}`}
              />
            </div>
          ))}
          {booleanArgs.length > 0 && (
            <div className="flex flex-col">
              {booleanArgs.map((arg) => (
                <label key={arg.name} className="h-7 flex items-center gap-2 text-xs text-ctp-subtext1 cursor-pointer" title={arg.description || undefined}>
                  <input
                    type="checkbox"
                    checked={configs[arg.name] === 'true'}
                    onChange={(e) => onConfigChange(arg.name, e.target.checked ? 'true' : '')}
                    disabled={disabled}
                    className="w-3.5 h-3.5 rounded accent-ctp-accent shrink-0"
                  />
                  <span className="font-mono">{arg.name.replace(/^--/, '')}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentSettingsView({ agent }: Props) {
  const isRunning = agent.status === 'running';
  const { closeAgentSettings, updateAgent, loadDurableAgents } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const worktreePath = agent.worktreePath || activeProject?.path || '';
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  // Resolve orchestrators the same way AddAgentDialog does — profile-aware and scoped
  // to this agent's project — so the selector behaves consistently with agent creation.
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const { effectiveOrchestrators } = useEffectiveOrchestrators(projectPath);
  const agentOrchestrator = agent.orchestrator || 'claude-code';
  // Scope the model list to *this agent's* orchestrator, not the project default —
  // otherwise a Codex/Copilot agent is offered (and validated against) Claude's ids.
  const { options: MODEL_OPTIONS, loading: modelOptionsLoading } = useModelOptions(agentOrchestrator);
  // Always offer the agent's current orchestrator, even if it's disabled app-wide or
  // missing from this machine's settings (e.g. a worktree-synced agent whose project
  // profile wasn't synced). See buildOrchestratorOptions / #fix-orchestrator-selector AC #2.
  const orchestratorOptions = useMemo(
    () => buildOrchestratorOptions(effectiveOrchestrators, allOrchestrators, agentOrchestrator),
    [effectiveOrchestrators, allOrchestrators, agentOrchestrator],
  );

  // The new chrome lists the pages in the sidebar and shows one at a time;
  // the classic shell stacks them on one page.
  const pageMode = useChromeFlagStore((s) => s.enabled);
  const page = useAgentSettingsPages((s) => s.page);
  const setPage = useAgentSettingsPages((s) => s.setPage);
  const setDirtyPages = useAgentSettingsPages((s) => s.setDirtyPages);
  const setCount = useAgentSettingsPages((s) => s.setCount);
  const resetPages = useAgentSettingsPages((s) => s.reset);
  const killAgent = useAgentStore((s) => s.killAgent);

  // Every agent opens on General with its shell closed.
  useEffect(() => {
    resetPages();
  }, [agent.id, resetPages]);

  // Clubhouse-managed agents (#2893): the setup on the agent's config, kept fresh as parts change.
  const [managedSetup, setManagedSetup] = useState<ManagedAgentSetup | null>(null);
  const [clubhouseFeatures, setClubhouseFeatures] = useState(true);
  useEffect(() => {
    if (!projectPath || isRemoteProjectId(agent.projectId)) { setManagedSetup(null); return; }
    let cancelled = false;
    const load = () => {
      window.clubhouse.agent.getDurableConfig(projectPath, agent.id)
        .then((c) => { if (!cancelled) { setManagedSetup(c?.managed ?? null); setClubhouseFeatures(c?.clubhouseFeatures !== false); } })
        .catch(() => { /* telemetry-exempt: the General page shows the agent as unmanaged until a read works */ });
    };
    load();
    const off = window.clubhouse.managed.onChanged(load);
    return () => { cancelled = true; off(); };
  }, [projectPath, agent.id, agent.projectId]);
  const isManagedAgent = !!managedSetup;
  // One object per agent, so the builder doesn't see a new target on every render.
  const builderAgent = useMemo(
    () => (projectPath ? { projectPath, agentId: agent.id, agentName: agent.name } : null),
    [projectPath, agent.id, agent.name],
  );
  const builderTarget = useMemo(() => (builderAgent ? { kind: 'agent' as const, agent: builderAgent } : null), [builderAgent]);

  // Helpers (#2232): not for a helper or an agent on another machine, like the Orchestration card.
  const setHiddenPages = useAgentSettingsPages((s) => s.setHiddenPages);
  const hiddenPages = useMemo(
    () => hiddenAgentSettingsPages(agent, isRemoteProjectId(agent.projectId), !!managedSetup),
    [agent.parentAgentId, agent.projectId, !!managedSetup],
  );
  useEffect(() => {
    setHiddenPages(hiddenPages);
  }, [agent.id, hiddenPages, setHiddenPages]);
  const showHelpers = !hiddenPages.includes('helpers');

  // A page asked for by whoever opened settings ("What changed" asks for Preview),
  // selected once it shows for this agent: a managed agent's builder pages appear after its setup loads.
  const requestedPage = useAgentSettingsPages((s) => s.requestedPage);
  useEffect(() => {
    if (!requestedPage || requestedPage.agentId !== agent.id || hiddenPages.includes(requestedPage.page)) return;
    setPage(requestedPage.page);
    // The classic shell stacks the pages: bring the asked-for section into view instead.
    if (!pageMode) document.getElementById(`agent-settings-section-${requestedPage.page}`)?.scrollIntoView?.({ block: 'start' });
  }, [requestedPage, agent.id, hiddenPages, setPage, pageMode]);

  // Shell in worktree: the sidebar row (new chrome) or the row under the page
  // (classic) opens it. It stays mounted once opened.
  const shellOpen = useAgentSettingsPages((s) => s.shellOpen);
  const setShellOpen = useAgentSettingsPages((s) => s.setShellOpen);
  const [shellHasOpened, setShellHasOpened] = useState(false);
  useEffect(() => {
    if (shellOpen) setShellHasOpened(true);
  }, [shellOpen]);

  // Appearance editing state. The name saves on blur or Enter, like the other General settings.
  const [renameValue, setRenameValue] = useState(agent.name);
  const [cropImageDataUrl, setCropImageDataUrl] = useState<string | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const { pickAgentIcon, saveAgentIcon, removeAgentIcon, agentIcons } = useAgentStore();
  const iconDataUrl = agentIcons[agent.id];

  useEffect(() => {
    setRenameValue(agent.name);
  }, [agent.name]);

  const handleRenameConfirm = async () => {
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenameValue(agent.name);
      return;
    }
    if (trimmed !== agent.name && activeProject) {
      await updateAgent(agent.id, { name: trimmed }, activeProject.path);
    }
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenameValue(agent.name);
    }
  };

  const handleStop = async () => {
    await killAgent(agent.id);
  };

  const handleColorChange = async (colorId: string) => {
    if (!activeProject || colorId === agent.color) return;
    await updateAgent(agent.id, { color: colorId }, activeProject.path);
  };

  const handlePickIcon = async () => {
    const dataUrl = await pickAgentIcon(agent.id, activeProject?.path || '');
    if (dataUrl) {
      setCropImageDataUrl(dataUrl);
    }
  };

  const handleCropConfirm = async (croppedDataUrl: string) => {
    setCropImageDataUrl(null);
    if (!activeProject) return;
    await saveAgentIcon(agent.id, activeProject.path, croppedDataUrl);
  };

  const handleCropCancel = () => {
    setCropImageDataUrl(null);
  };

  const handleRemoveIcon = async () => {
    if (!activeProject) return;
    await removeAgentIcon(agent.id, activeProject.path);
  };

  const handleEmojiSelect = async (emoji: string) => {
    if (!activeProject) return;
    await updateAgent(agent.id, { emoji }, activeProject.path);
    // Clear image icon since emoji takes precedence
    if (agent.icon) {
      await removeAgentIcon(agent.id, activeProject.path);
    }
  };

  const handleRemoveEmoji = async () => {
    if (!activeProject) return;
    await updateAgent(agent.id, { emoji: null }, activeProject.path);
  };

  const handleFreeAgentModeChange = async (enabled: boolean) => {
    if (!projectPath) return;
    setFreeAgentMode(enabled);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { freeAgentMode: enabled });
    // Update in-memory store so UI reflects immediately
    useAgentStore.setState((s) => {
      const existing = s.agents[agent.id];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [agent.id]: { ...existing, freeAgentMode: enabled || undefined },
        },
      };
    });
  };

  const handleOrchestratorChange = async (value: string) => {
    if (!projectPath) return;
    // Main resets the model on a new CLI, as it can't run the old one's (#2593).
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { orchestrator: value, model: 'default' });
    setSavedModel('default');
    useAgentStore.setState((s) => {
      const existing = s.agents[agent.id];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [agent.id]: { ...existing, orchestrator: value, model: undefined },
        },
      };
    });
  };

  const { requestCliChange, cliChangeDialog } = useCliChangeConfirm({
    projectPath,
    agentId: agent.id,
    agentName: agent.name,
    enabled: !isRunning,
    apply: handleOrchestratorChange,
  });

  // Agent model state.
  //
  // The persisted id is kept raw in `savedModel`; splitting it into the dropdown
  // selection + custom text box happens in the effect below. That split MUST wait
  // for useModelOptions to finish fetching — while the request is in flight the
  // hook reports a `default`-only placeholder, and classifying against it would
  // mislabel every real id (e.g. `sonnet`) as "Custom...".
  const isKnownModel = (id: string) => MODEL_OPTIONS.some((opt) => opt.id === id);
  const [savedModel, setSavedModel] = useState(agent.model || 'default');
  const [agentModel, setAgentModel] = useState('default');
  const [agentCustomModel, setAgentCustomModel] = useState('');

  const persistModel = async (value: string) => {
    if (!projectPath) return;
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { model: value });
    useAgentStore.setState((s) => {
      const existing = s.agents[agent.id];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [agent.id]: { ...existing, model: value === 'default' ? undefined : value },
        },
      };
    });
  };

  // The saved next-start choice (#2660). Main can clear it on a new model or CLI, so it's read back after those.
  const [contextWindow, setContextWindow] = useState<string | undefined>();
  const [contextWindowNotice, setContextWindowNotice] = useState<string | undefined>();
  const contextOptions = useContextWindowOptions(!!projectPath && !isRunning, projectPath, agentOrchestrator, savedModel);
  useEffect(() => {
    if (!projectPath) return;
    let alive = true;
    window.clubhouse.agent.getDurableConfig(projectPath, agent.id).then((c) => {
      if (!alive) return;
      setContextWindow(c?.contextWindow);
      setContextWindowNotice(c?.contextWindowNotice);
    }).catch(() => {
      // telemetry-exempt: the row shows no saved choice; saving still validates in main.
    });
    return () => { alive = false; };
  }, [projectPath, agent.id, savedModel, agentOrchestrator]);
  const handleContextWindowChange = async (value: string | null) => {
    if (!projectPath) return;
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { contextWindow: value });
    setContextWindow(value ?? undefined);
    setContextWindowNotice(undefined);
  };

  const handleModelChange = async (value: string) => {
    setAgentModel(value);
    if (value === 'custom') {
      // Don't persist yet — wait for custom input
      setAgentCustomModel('');
    } else {
      setSavedModel(value);
      await persistModel(value);
    }
  };

  const handleCustomModelBlur = async () => {
    const trimmed = agentCustomModel.trim();
    if (trimmed) {
      setSavedModel(trimmed);
      await persistModel(trimmed);
    }
  };

  // Resolve orchestrator display name
  const orchestratorInfo = allOrchestrators.find((o) => o.id === agentOrchestrator);

  // Resolve capabilities for the agent's orchestrator
  const capabilities = allOrchestrators.find((o) => o.id === agentOrchestrator)?.capabilities;

  // Text edits wait for the save bar. Each keeps what was last loaded or saved,
  // so Discard can put it back.
  // Instructions state
  const [instructions, setInstructions] = useState('');
  const [instructionsBase, setInstructionsBase] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsLoaded, setInstructionsLoaded] = useState(false);

  // Permissions state (main agent — stored in .claude/settings.local.json)
  const [permAllow, setPermAllow] = useState('');
  const [permDeny, setPermDeny] = useState('');
  const [permBase, setPermBase] = useState({ allow: '', deny: '' });
  const [permDirty, setPermDirty] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [permLoaded, setPermLoaded] = useState(false);

  // Free Agent Mode state (main agent)
  const [freeAgentMode, setFreeAgentMode] = useState(agent.freeAgentMode ?? false);

  // Quick Agent Defaults state
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadCustomModel, setQadCustomModel] = useState('');
  const [qadSavedModel, setQadSavedModel] = useState('');
  const [qadBase, setQadBase] = useState({ systemPrompt: '', allowedTools: '', savedModel: '', freeAgentMode: false });

  // Split the raw persisted model ids into dropdown selection + custom text box.
  // Deliberately gated on `modelOptionsLoading` and re-run when MODEL_OPTIONS
  // arrives, so a known id is never transiently latched as "Custom...".
  useEffect(() => {
    if (modelOptionsLoading) return;
    if (isKnownModel(savedModel)) {
      setAgentModel(savedModel);
      setAgentCustomModel('');
    } else {
      setAgentModel('custom');
      setAgentCustomModel(savedModel);
    }
    if (qadSavedModel && !isKnownModel(qadSavedModel)) {
      setQadDefaultModel('custom');
      setQadCustomModel(qadSavedModel);
    } else {
      setQadDefaultModel(qadSavedModel);
      setQadCustomModel('');
    }
    // Intentionally keyed on the option list identity rather than isKnownModel,
    // which is re-created every render.
  }, [savedModel, qadSavedModel, modelOptionsLoading, MODEL_OPTIONS]);
  const [qadFreeAgentMode, setQadFreeAgentMode] = useState(false);
  const [qadDirty, setQadDirty] = useState(false);
  const [qadSaving, setQadSaving] = useState(false);
  const [qadLoaded, setQadLoaded] = useState(false);

  // MCP catalog state for per-agent wrapper MCPs
  const [mcpCatalog, setMcpCatalog] = useState<McpCatalogEntry[]>([]);
  const [agentMcpIds, setAgentMcpIds] = useState<string[]>([]);
  const [agentMcpConfigs, setAgentMcpConfigs] = useState<Record<string, Record<string, string>>>({});
  const [mcpLoaded, setMcpLoaded] = useState(false);

  // Clubhouse Mode state
  const isClubhouseModeEnabled = useClubhouseModeStore((s) => s.isEnabledForProject);
  const loadClubhouseSettings = useClubhouseModeStore((s) => s.loadSettings);
  const [clubhouseModeOverride, setClubhouseModeOverride] = useState(false);
  const clubhouseActive = projectPath ? isClubhouseModeEnabled(projectPath) : false;
  const isManagedByClubhouse = clubhouseActive && !clubhouseModeOverride;

  // Persona state (per-agent override of project default)
  const [agentPersona, setAgentPersona] = useState('');

  // Chat / CLI runtime override ('' = provider default). Only offered
  // when Chat is on.
  const [chatFlagEnabled, setChatFlagEnabled] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<AgentRuntimeMode | ''>('');
  const runtimeTarget = JSON.stringify([projectPath, agent.id]);
  const runtimeRequest = useRef({ target: runtimeTarget, epoch: 0, pending: false });
  if (runtimeRequest.current.target !== runtimeTarget) runtimeRequest.current = { target: runtimeTarget, epoch: 0, pending: false };
  const [runtimeSaving, setRuntimeSaving] = useState(false);
  const [runtimeSaveFailed, setRuntimeSaveFailed] = useState(false);
  const [runtimeLoadedTarget, setRuntimeLoadedTarget] = useState('');
  const [runtimeLoadFailed, setRuntimeLoadFailed] = useState(false);
  const [runtimeLoadAttempt, setRuntimeLoadAttempt] = useState(0);


  useEffect(() => {
    loadClubhouseSettings();
  }, [loadClubhouseSettings]);

  useEffect(() => {
    let cancelled = false;
    // Same gate as main: on unless the flag is saved off.
    window.clubhouse.app.getExperimentalSettings()
      .then((s) => { if (!cancelled) setChatFlagEnabled(isGraduatedFlagOn(s, 'chat')); })
      .catch(() => { /* flag stays off */ });
    return () => { cancelled = true; };
  }, []);

  // Load clubhouse mode override + persona from durable config
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    const request = runtimeRequest.current;
    const epoch = request.epoch;
    setRuntimeSaving(false); setRuntimeSaveFailed(false); setRuntimeLoadedTarget(''); setRuntimeLoadFailed(false);
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
        if (cancelled || request !== runtimeRequest.current) return;
        setClubhouseModeOverride(config?.clubhouseModeOverride ?? false);
        setAgentPersona(config?.persona ?? '');
        if (request.epoch === epoch) setRuntimeMode(config?.runtimeMode ?? '');
        setRuntimeLoadedTarget(runtimeTarget);
      } catch {
        // telemetry-exempt: do not offer an unknown rollback value after a failed read.
        if (!cancelled && request === runtimeRequest.current) setRuntimeLoadFailed(true);
      }
    })();
    return () => { cancelled = true; request.epoch++; };
  }, [projectPath, agent.id, runtimeLoadAttempt]);

  const handleRuntimeModeChange = async (value: AgentRuntimeMode | '') => {
    const request = runtimeRequest.current;
    if (!projectPath || isRunning || request.pending || runtimeLoadedTarget !== runtimeTarget) return;
    const epoch = ++request.epoch;
    request.pending = true;
    const previous = runtimeMode;
    setRuntimeSaving(true); setRuntimeSaveFailed(false); setRuntimeMode(value);
    const current = () => runtimeRequest.current === request && request.epoch === epoch;
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { runtimeMode: value === '' ? null : value });
    } catch {
      // telemetry-exempt: fixed visible failure, with the previous choice restored.
      if (current()) { setRuntimeMode(previous); setRuntimeSaveFailed(true); }
    } finally {
      request.pending = false;
      if (current()) setRuntimeSaving(false);
    }
  };

  // Refresh counter — increment to force re-read from disk
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefreshAll = () => {
    setRefreshKey((k) => k + 1);
    setInstructionsDirty(false);
    setPermDirty(false);
    setQadDirty(false);
  };

  // Plugin template → TemplateConfigDialog flow
  const [pendingPluginTemplate, setPendingPluginTemplate] = useState<RegisteredPluginAgentTemplate | null>(null);

  const handleCreateFromPluginTemplate = (entry: RegisteredPluginAgentTemplate) => {
    setPendingPluginTemplate(entry);
  };

  const handlePluginTemplateCreate = async (templateConfig: TemplateConfig) => {
    const entry = pendingPluginTemplate;
    setPendingPluginTemplate(null);
    if (!entry || !projectPath) return;

    try {
      const { name, color, model, orchestrator: orch, useWorktree, freeAgentMode, mcpIds } = templateConfig;

      // Create durable agent with user-chosen config
      const config = await window.clubhouse.agent.createDurable(
        projectPath, name, color, model !== 'default' ? model : undefined, useWorktree,
        orch, freeAgentMode || undefined, mcpIds, undefined,
      );

      const agentWorktree = config.worktreePath || worktreePath;

      // Write plugin template prompt as the agent's instructions
      if (entry.template.promptContent) {
        await window.clubhouse.agentSettings.saveInstructions(agentWorktree, entry.template.promptContent, projectPath);
      }

      // Inject skills from the plugin template
      if (entry.template.skills) {
        for (const [skillName, content] of Object.entries(entry.template.skills)) {
          await window.clubhouse.agentSettings.writeSkillContent(agentWorktree, skillName, content, projectPath);
        }
      }

      // Inject MCP servers from the plugin template into the agent's .mcp.json
      if (entry.template.mcpServers && Object.keys(entry.template.mcpServers).length > 0) {
        const rawJson = await window.clubhouse.agentSettings.readMcpRawJson(agentWorktree, projectPath, config.id);
        let mcpConfig: Record<string, unknown>;
        try {
          mcpConfig = JSON.parse(rawJson);
        } catch {
          mcpConfig = {};
        }
        if (!mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== 'object') {
          mcpConfig.mcpServers = {};
        }
        const servers = mcpConfig.mcpServers as Record<string, unknown>;
        for (const [serverName, serverDef] of Object.entries(entry.template.mcpServers)) {
          servers[serverName] = serverDef;
        }
        await window.clubhouse.agentSettings.writeMcpRawJson(agentWorktree, JSON.stringify(mcpConfig, null, 2), projectPath, config.id);
      }

      // Refresh agent list so the new agent appears
      if (activeProject) {
        await loadDurableAgents(activeProject.id, projectPath);
      }

      setRefreshKey((k) => k + 1);
    } catch (err) {
      console.error('Failed to create from plugin template:', err);
    }
  };

  // Load quick agent defaults and agent model from config
  useEffect(() => {
    if (!projectPath) return;
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
        const defaults = config?.quickAgentDefaults;
        if (defaults) {
          const base = {
            systemPrompt: defaults.systemPrompt || '',
            allowedTools: (defaults.allowedTools || []).join('\n'),
            savedModel: defaults.defaultModel || '',
            freeAgentMode: defaults.freeAgentMode ?? false,
          };
          setQadSystemPrompt(base.systemPrompt);
          setQadAllowedTools(base.allowedTools);
          setQadSavedModel(base.savedModel);
          setQadFreeAgentMode(base.freeAgentMode);
          setQadBase(base);
        }
        setQadDirty(false);
        // Sync agent model from disk — disk is the source of truth. Classification
        // into known-vs-custom is left to the effect that waits on MODEL_OPTIONS.
        setSavedModel(config?.model || 'default');
        setFreeAgentMode(config?.freeAgentMode ?? false);
        setQadLoaded(true);
      } catch {
        setQadLoaded(true);
      }
    })();
  }, [projectPath, agent.id, refreshKey]);

  // Load MCP catalog and agent's current MCP state
  useEffect(() => {
    if (!projectPath) return;
    (async () => {
      try {
        const [catalog, config] = await Promise.all([
          window.clubhouse.project.readMcpCatalog(projectPath),
          window.clubhouse.agent.getDurableConfig(projectPath, agent.id),
        ]);
        setMcpCatalog(catalog || []);
        setAgentMcpIds(config?.mcpIds || []);
        setAgentMcpConfigs(config?.mcpConfigs || {});
        setMcpLoaded(true);
      } catch {
        setMcpLoaded(true);
      }
    })();
  }, [projectPath, agent.id, refreshKey]);

  const handleToggleMcp = async (id: string) => {
    if (!projectPath) return;
    const next = agentMcpIds.includes(id)
      ? agentMcpIds.filter((m) => m !== id)
      : [...agentMcpIds, id];
    setAgentMcpIds(next);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, {
      mcpIds: next.length > 0 ? next : null,
    });
  };

  const handleMcpConfigChange = async (mcpId: string, flag: string, value: string) => {
    if (!projectPath) return;
    const entry = { ...agentMcpConfigs[mcpId] };
    if (value) {
      entry[flag] = value;
    } else {
      delete entry[flag];
    }
    const next = { ...agentMcpConfigs };
    if (Object.keys(entry).length > 0) {
      next[mcpId] = entry;
    } else {
      delete next[mcpId];
    }
    setAgentMcpConfigs(next);
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, {
        mcpConfigs: Object.keys(next).length > 0 ? next : null,
      });
    } catch {
      setAgentMcpConfigs(agentMcpConfigs);
    }
  };

  // Load instructions file for agent's orchestrator
  useEffect(() => {
    const readPath = worktreePath || projectPath;
    if (!readPath || !projectPath) return;
    (async () => {
      try {
        const content = await window.clubhouse.agentSettings.readInstructions(readPath, projectPath);
        setInstructions(content || '');
        setInstructionsBase(content || '');
        setInstructionsLoaded(true);
        setInstructionsDirty(false);
      } catch {
        setInstructionsLoaded(true);
      }
    })();
  }, [worktreePath, projectPath, refreshKey]);

  // Load permissions from settings file (convention-aware)
  useEffect(() => {
    const readPath = worktreePath || projectPath;
    if (!readPath) return;
    (async () => {
      try {
        const perms = await window.clubhouse.agentSettings.readPermissions(readPath, projectPath);
        const base = { allow: (perms.allow || []).join('\n'), deny: (perms.deny || []).join('\n') };
        setPermAllow(base.allow);
        setPermDeny(base.deny);
        setPermBase(base);
        setPermLoaded(true);
        setPermDirty(false);
      } catch {
        setPermLoaded(true);
      }
    })();
  }, [worktreePath, projectPath, refreshKey]);

  const handleSaveInstructions = async () => {
    const writePath = worktreePath || projectPath;
    if (!writePath || !projectPath) return;
    setInstructionsSaving(true);
    try {
      await window.clubhouse.agentSettings.saveInstructions(writePath, instructions, projectPath);
      setInstructionsBase(instructions);
      setInstructionsDirty(false);
    } finally {
      setInstructionsSaving(false);
    }
  };

  const handleSavePermissions = async () => {
    const writePath = worktreePath || projectPath;
    if (!writePath) return;
    setPermSaving(true);
    const allow = permAllow.split('\n').map((l) => l.trim()).filter(Boolean);
    const deny = permDeny.split('\n').map((l) => l.trim()).filter(Boolean);
    try {
      await window.clubhouse.agentSettings.savePermissions(writePath, {
        allow: allow.length > 0 ? allow : undefined,
        deny: deny.length > 0 ? deny : undefined,
      }, projectPath);
      setPermBase({ allow: permAllow, deny: permDeny });
      setPermDirty(false);
    } finally {
      setPermSaving(false);
    }
  };

  const handleOpenAgentRoot = () => {
    const rootPath = worktreePath || projectPath;
    if (rootPath) {
      window.clubhouse.file.showInFolder(rootPath);
    }
  };

  // Resolve file/dir labels from orchestrator conventions
  const conventions = orchestratorInfo?.conventions;
  const instructionsFileLabel = (() => {
    if (!conventions) return 'instructions';
    const { configDir, localInstructionsFile } = conventions;
    // Claude Code: CLAUDE.md lives at project root, not under configDir
    if (localInstructionsFile === 'CLAUDE.md') return 'CLAUDE.md';
    return `${configDir}/${localInstructionsFile}`;
  })();
  const skillsPathLabel = conventions ? `${conventions.configDir}/${conventions.skillsDir}/` : '.claude/skills/';
  const agentTemplatesPathLabel = conventions ? `${conventions.configDir}/${conventions.agentTemplatesDir}/` : '.claude/agents/';
  const mcpPathLabel = conventions?.mcpConfigFile || '.mcp.json';
  const permissionsPathLabel = conventions?.permissionRules === false ? 'Not supported by this provider' : conventions ? `${conventions.configDir}/${conventions.localSettingsFile}` : '.claude/settings.local.json';

  const handleSaveQad = async () => {
    if (!projectPath) return;
    setQadSaving(true);
    const defaults: QuickAgentDefaults = {};
    if (qadSystemPrompt.trim()) defaults.systemPrompt = qadSystemPrompt.trim();
    const tools = qadAllowedTools.split('\n').map((l) => l.trim()).filter(Boolean);
    if (tools.length > 0) defaults.allowedTools = tools;
    const resolvedQadModel = qadDefaultModel === 'custom' ? qadCustomModel.trim() : qadDefaultModel;
    if (resolvedQadModel && resolvedQadModel !== 'default') defaults.defaultModel = resolvedQadModel;
    if (qadFreeAgentMode) defaults.freeAgentMode = true;
    try {
      await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { quickAgentDefaults: defaults });
      setQadBase({
        systemPrompt: qadSystemPrompt,
        allowedTools: qadAllowedTools,
        savedModel: resolvedQadModel && resolvedQadModel !== 'default' ? resolvedQadModel : '',
        freeAgentMode: qadFreeAgentMode,
      });
      setQadDirty(false);
    } finally {
      setQadSaving(false);
    }
  };

  // ── One save bar ───────────────────────────────────────────────
  //
  // Text edits on this view (instructions, permissions, quick agent defaults)
  // and the sections that join the bar (.mcp.json, wildcards) save and discard
  // together. Skills and agent definition editors keep their own Save and
  // Cancel, but their open edits still mark the page and guard leaving.

  const [sectionDirty, setSectionDirty] = useState<Record<SectionKey, boolean>>(NO_SECTION_DIRTY);
  const sectionHandles = useRef<Partial<Record<BarSectionKey, SaveHandle>>>({});
  const sectionCallbacks = useMemo(() => {
    const dirty = (key: SectionKey) => (d: boolean) => setSectionDirty((prev) => (prev[key] === d ? prev : { ...prev, [key]: d }));
    const register = (key: BarSectionKey) => (handle: SaveHandle | null) => {
      if (handle) sectionHandles.current[key] = handle;
      else delete sectionHandles.current[key];
    };
    const count = (p: AgentSettingsPage) => (n: number) => setCount(p, n);
    return {
      mcpDirty: dirty('mcp'), wildcardsDirty: dirty('wildcards'), skillsDirty: dirty('skills'), definitionsDirty: dirty('definitions'),
      mcpRegister: register('mcp'), wildcardsRegister: register('wildcards'),
      skillsCount: count('skills'), definitionsCount: count('definitions'), mcpCount: count('mcp'),
    };
  }, [setCount]);

  /** What the bar saves and discards, in page order. */
  const barItems: BarItem[] = [];
  if (sectionDirty.wildcards) barItems.push({ key: 'wildcards', name: 'wildcards', save: () => sectionHandles.current.wildcards?.save() ?? Promise.resolve(), discard: () => sectionHandles.current.wildcards?.discard() });
  if (instructionsDirty) barItems.push({ key: 'instructions', name: 'instructions', save: handleSaveInstructions, discard: () => discardInstructions() });
  if (sectionDirty.mcp) barItems.push({ key: 'mcp', name: 'MCP servers', save: () => sectionHandles.current.mcp?.save() ?? Promise.resolve(), discard: () => sectionHandles.current.mcp?.discard() });
  if (permDirty) barItems.push({ key: 'permissions', name: 'permissions', save: handleSavePermissions, discard: () => discardPermissions() });
  if (qadDirty) barItems.push({ key: 'quick', name: 'quick agent defaults', save: handleSaveQad, discard: () => discardQad() });

  const dirtyPages = useMemo(() => {
    const dirty = new Set<AgentSettingsPage>();
    if (sectionDirty.wildcards) dirty.add('general');
    if (instructionsDirty) dirty.add('instructions');
    if (sectionDirty.skills) dirty.add('skills');
    if (sectionDirty.definitions) dirty.add('definitions');
    if (sectionDirty.mcp) dirty.add('mcp');
    if (permDirty) dirty.add('permissions');
    if (qadDirty) dirty.add('quick');
    return AGENT_SETTINGS_PAGES.map((p) => p.page).filter((p) => dirty.has(p));
  }, [sectionDirty, instructionsDirty, permDirty, qadDirty]);

  useEffect(() => {
    setDirtyPages(dirtyPages);
  }, [dirtyPages, setDirtyPages]);

  const [savingAll, setSavingAll] = useState(false);
  const saving = savingAll || instructionsSaving || permSaving || qadSaving;

  /** Saves every item; one failure doesn't stop the rest, and the toast says which saved. */
  const handleSaveAll = async () => {
    setSavingAll(true);
    const saved: string[] = [];
    const failed: string[] = [];
    for (const item of barItems) {
      try {
        await item.save();
        saved.push(item.name);
      } catch (err) {
        failed.push(item.name);
        reportChromeActionFailed('agent_settings_save', err);
      }
    }
    setSavingAll(false);
    if (failed.length > 0) {
      useToastStore.getState().addToast(
        saved.length > 0
          ? `Saved ${joinNames(saved)}. Couldn't save ${joinNames(failed)}.`
          : `Couldn't save ${joinNames(failed)}.`,
        'error',
      );
    }
  };

  const discardInstructions = () => {
    setInstructions(instructionsBase);
    setInstructionsDirty(false);
  };
  const discardPermissions = () => {
    setPermAllow(permBase.allow);
    setPermDeny(permBase.deny);
    setPermDirty(false);
  };
  const discardQad = () => {
    setQadSystemPrompt(qadBase.systemPrompt);
    setQadAllowedTools(qadBase.allowedTools);
    setQadFreeAgentMode(qadBase.freeAgentMode);
    setQadSavedModel(qadBase.savedModel);
    if (qadBase.savedModel && !isKnownModel(qadBase.savedModel)) {
      setQadDefaultModel('custom');
      setQadCustomModel(qadBase.savedModel);
    } else {
      setQadDefaultModel(qadBase.savedModel);
      setQadCustomModel('');
    }
    setQadDirty(false);
  };

  const handleDiscard = () => {
    for (const item of barItems) item.discard();
  };

  // ── Leaving with unsaved edits ─────────────────────────────────

  const pendingLeave = useAgentSettingsPages((s) => s.pendingLeave);
  const setPendingLeave = useAgentSettingsPages((s) => s.setPendingLeave);

  // Nothing here is unsaved once the view is gone.
  useEffect(() => () => setDirtyPages([]), [setDirtyPages]);
  const dirtyPageNames = dirtyPages.map((p) => AGENT_SETTINGS_PAGES.find((x) => x.page === p)?.label ?? p);

  // ── Sidebar counts ─────────────────────────────────────────────
  //
  // The sections report their own counts as they load and change. Clubhouse
  // Mode hides those sections, so their counts no longer apply.

  const clearCounts = useAgentSettingsPages((s) => s.clearCounts);
  useEffect(() => {
    if (isManagedByClubhouse) clearCounts();
  }, [isManagedByClubhouse, clearCounts]);

  // ── Pieces ─────────────────────────────────────────────────────

  const relativeWorktree = projectPath && worktreePath.startsWith(`${projectPath}/`)
    ? worktreePath.slice(projectPath.length + 1)
    : worktreePath;
  const permissionsSupported = capabilities?.permissions ?? false;
  const orchestratorName = orchestratorInfo?.displayName || 'this CLI';
  const stopFirst = isRunning ? 'Stop the agent to change this' : undefined;

  const reloadButton = (
    <Button
      kind="quiet"
      onClick={handleRefreshAll}
      title="Reload from disk"
      aria-label="Reload from disk"
      data-testid="agent-settings-reload"
      icon={(
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 2v6h-6" />
          <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
          <path d="M3 22v-6h6" />
          <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
        </svg>
      )}
    />
  );

  const runningLine = isRunning && (
    <div data-testid="agent-settings-running" className="h-10 mb-2 flex items-center gap-2 border-b border-surface-0 text-[13px]">
      <span className="w-2 h-2 rounded-full flex-shrink-0 bg-ctp-success" aria-hidden="true" />
      <span className="text-ctp-text">Working</span>
      <span className="text-xs text-ctp-overlay1 truncate">Stop the agent to change these settings.</span>
      <Button
        kind="ghost"
        onClick={handleStop}
        className="ml-auto"
        icon={<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>}
      >
        Stop
      </Button>
    </div>
  );

  const freeAgentModeHelp = !permissionsSupported
    ? `Not supported by ${orchestratorName}.`
    : 'Handle permissions using the configured Free agent permission mode.';

  const general = (
    <>
      <SectionHeading title="Identity" />
      <Field label="Name" htmlFor="agent-settings-name">
        <input
          id="agent-settings-name"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameConfirm}
          onKeyDown={handleRenameKeyDown}
          disabled={isRunning}
          title={isRunning ? 'Stop the agent to rename it' : undefined}
          spellCheck={false}
          className={`${inputClass} w-60`}
        />
      </Field>
      <Field label="Color">
        <div role="radiogroup" aria-label="Color" className="flex gap-2">
          {AGENT_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={agent.color === c.id}
              aria-label={c.label}
              onClick={() => handleColorChange(c.id)}
              disabled={isRunning}
              className={`w-[18px] h-[18px] rounded-full cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 ${
                agent.color === c.id ? 'outline outline-2 outline-offset-2 outline-ctp-text' : ''
              }`}
              style={{ backgroundColor: c.hex }}
            />
          ))}
        </div>
      </Field>
      <Field label="Icon" help="An image or emoji in place of the initials.">
        <div className="relative flex items-center gap-2">
          <AgentAvatar agent={agent} size="xs" iconUrl={iconDataUrl} />
          <Button onClick={handlePickIcon} disabled={isRunning}>
            Choose image…
          </Button>
          <Button
            kind="quiet"
            ref={emojiButtonRef}
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            disabled={isRunning}
          >
            Emoji…
          </Button>
          {((agent.icon && iconDataUrl) || agent.emoji) && !isRunning && (
            <Button kind="quiet" onClick={agent.emoji ? handleRemoveEmoji : handleRemoveIcon}>
              Remove
            </Button>
          )}
          {showEmojiPicker && (
            <div className="absolute top-8 right-0 z-dropdown">
              <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmojiPicker(false)} />
            </div>
          )}
        </div>
      </Field>

      <SectionHeading title="Runtime" sub="Applied on the next wake" />
      {orchestratorOptions.length > 1 ? (
        <Field label="Runs on" htmlFor="agent-settings-orchestrator">
          <select
            id="agent-settings-orchestrator"
            value={agentOrchestrator}
            onChange={(e) => void requestCliChange(e.target.value)}
            disabled={isRunning}
            title={stopFirst}
            className={selectClass}
          >
            {orchestratorOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.displayName}</option>
            ))}
          </select>
        </Field>
      ) : (orchestratorInfo || orchestratorOptions[0]) ? (
        <Field label="Runs on">
          <span className="text-xs text-ctp-subtext1">{(orchestratorInfo || orchestratorOptions[0]).displayName}</span>
        </Field>
      ) : null}
      <Field label="Model" htmlFor="agent-settings-model">
        {agentModel === 'custom' && (
          <input
            type="text"
            aria-label="Custom model"
            value={agentCustomModel}
            onChange={(e) => setAgentCustomModel(e.target.value)}
            onBlur={handleCustomModelBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCustomModelBlur(); }}
            placeholder="e.g. claude-opus-4-6"
            disabled={isRunning}
            spellCheck={false}
            className={`${inputClass} w-44`}
          />
        )}
        <select
          id="agent-settings-model"
          value={agentModel}
          onChange={(e) => handleModelChange(e.target.value)}
          disabled={isRunning}
          title={stopFirst}
          className={selectClass}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
          <option value="custom">Custom...</option>
        </select>
      </Field>
      <Field label={contextOptions?.label ?? 'Context'} help={contextWindowHelp(contextOptions)} htmlFor="agent-settings-context">
        {/* Awake it can't change, so the saved choice is enough and the CLI's catalog isn't read. */}
        {isRunning ? (
          <span title={stopFirst} data-testid="agent-settings-context-saved">
            {contextWindow ? `${formatContextChoice(contextWindow)} on the next start` : 'CLI default'}
          </span>
        ) : (
          <ContextWindowSelect
            id="agent-settings-context"
            options={contextOptions}
            value={contextWindow}
            className={selectClass}
            onChange={(v) => void handleContextWindowChange(v)}
          />
        )}
        {contextWindowNotice && <p className="text-ctp-subtext0 mt-1" data-testid="agent-settings-context-notice">{contextWindowNotice}</p>}
      </Field>
      {chatFlagEnabled && (
        <Field label="Runtime" help="Chat or CLI for this agent. Overrides the provider setting." htmlFor="agent-settings-runtime">
          <select
            id="agent-settings-runtime"
            aria-label="Runtime"
            value={runtimeMode}
            onChange={(e) => handleRuntimeModeChange(e.target.value as AgentRuntimeMode | '')}
            disabled={isRunning || runtimeSaving || runtimeLoadedTarget !== runtimeTarget}
            title={stopFirst}
            className={selectClass}
          >
            <option value="">Provider default</option>
            <option value="chat">Chat</option>
            <option value="terminal">CLI</option>
          </select>
          {runtimeLoadFailed && <p role="alert" className="text-ctp-error mt-1">Couldn't load the saved runtime. <button type="button" onClick={() => setRuntimeLoadAttempt((n) => n + 1)}>Retry loading runtime</button></p>}
          {runtimeSaveFailed && <p role="alert" className="text-ctp-error mt-1">Couldn't save that setting, so it wasn't changed. Try again.</p>}
        </Field>
      )}
      {chatFlagEnabled && projectPath && !isRemoteProjectId(agent.projectId) && (
        <HandshakeRetry projectPath={projectPath} agentId={agent.id} provider={agentOrchestrator} runtime={runtimeMode} />
      )}
      <Field
        label="Free Agent Mode"
        help={freeAgentMode && permissionsSupported
          ? <span className="text-ctp-error">Permissions follow the configured Free agent permission mode.</span>
          : freeAgentModeHelp}
        testId="agent-settings-free-agent-mode"
      >
        <Toggle
          checked={freeAgentMode}
          onChange={handleFreeAgentModeChange}
          disabled={isRunning || !permissionsSupported}
          aria-label="Free Agent Mode"
        />
      </Field>

      {projectPath && !isRemoteProjectId(agent.projectId) && (
        <ManagedGeneralSection
          projectPath={projectPath}
          agentId={agent.id}
          agentName={agent.name}
          setup={managedSetup}
          clubhouseFeatures={clubhouseFeatures}
          onClubhouseFeaturesChange={setClubhouseFeatures}
          isRunning={isRunning}
          legacy={isDispatcherAgent(agent) ? null : legacyUse({ managed: managedSetup ?? undefined, clubhouseModeOverride, persona: agentPersona }, clubhouseActive)}
          onClubhouseModeOff={async () => {
            await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { clubhouseModeOverride: true });
            setClubhouseModeOverride(true);
          }}
        />
      )}

      {!isManagedByClubhouse && !isManagedAgent && !pageMode && (
        <p className="mt-3 text-xs text-ctp-overlay1">
          Skills, agent definitions and MCP settings live in the agent worktree. Agents that share a root directory share them.
        </p>
      )}
    </>
  );

  const instructionsEditor = instructionsLoaded && (
    <>
      <textarea
        id="agent-settings-instructions"
        aria-label="Instructions"
        value={instructions}
        onChange={(e) => { setInstructions(e.target.value); setInstructionsDirty(true); }}
        disabled={isRunning}
        placeholder={`Agent instructions written to ${instructionsFileLabel}`}
        className={`${textareaClass} h-[226px] mt-1.5`}
        spellCheck={false}
      />
      <div className="flex items-center gap-2 mt-2 text-xs text-ctp-overlay1 min-w-0">
        <span className="flex-shrink-0">Written to the agent worktree at</span>
        <span className="font-mono text-ctp-subtext1 truncate">{relativeWorktree}</span>
        <Button kind="quiet" onClick={handleOpenAgentRoot} className="ml-auto">
          Open in Finder
        </Button>
      </div>
    </>
  );

  const skillsSection = (
    <SkillsSection
      agentId={agent.id}
      worktreePath={worktreePath}
      projectPath={projectPath}
      disabled={isRunning}
      refreshKey={refreshKey}
      pathLabel={skillsPathLabel}
      hideTitle={pageMode}
      onDirtyChange={sectionCallbacks.skillsDirty}
      onCountChange={sectionCallbacks.skillsCount}
    />
  );

  const definitionsSection = (
    <AgentTemplatesSection
      worktreePath={worktreePath}
      projectPath={projectPath}
      disabled={isRunning}
      refreshKey={refreshKey}
      pathLabel={agentTemplatesPathLabel}
      onCreateFromPluginTemplate={handleCreateFromPluginTemplate}
      hideTitle={pageMode}
      onDirtyChange={sectionCallbacks.definitionsDirty}
      onCountChange={sectionCallbacks.definitionsCount}
    />
  );

  const mcpSections = (
    <>
      <McpJsonSection
        worktreePath={worktreePath}
        projectPath={projectPath}
        agentId={agent.id}
        disabled={isRunning}
        refreshKey={refreshKey}
        pathLabel={mcpPathLabel}
        hideTitle={pageMode}
        onDirtyChange={sectionCallbacks.mcpDirty}
        onRegisterSave={sectionCallbacks.mcpRegister}
        onCountChange={sectionCallbacks.mcpCount}
      />
      {mcpLoaded && mcpCatalog.length > 0 && (
        <div data-testid="agent-settings-launch-wrapper">
          <SectionHeading title="Launch wrapper" />
          <p className="text-xs text-ctp-overlay1 mb-2">
            Servers the launch wrapper adds when this agent starts. Expand one to set its parameters.
          </p>
          {mcpCatalog.map((entry) => (
            <McpConfigRow
              key={entry.id}
              entry={{ ...entry, state: 'stable' as const }}
              checked={agentMcpIds.includes(entry.id)}
              configs={agentMcpConfigs[entry.id] || {}}
              disabled={isRunning}
              onToggle={() => handleToggleMcp(entry.id)}
              onConfigChange={(flag, value) => handleMcpConfigChange(entry.id, flag, value)}
            />
          ))}
        </div>
      )}
    </>
  );

  const permissionsEditor = conventions?.permissionRules === false ? (
    <p>Allow and deny rules are not supported by this provider. Use its native access controls.</p>
  ) : permLoaded && (
    <div className="mt-1.5">
      <FieldLabel htmlFor="agent-settings-perm-allow">Allowed tools, one per line</FieldLabel>
      <textarea
        id="agent-settings-perm-allow"
        value={permAllow}
        onChange={(e) => { setPermAllow(e.target.value); setPermDirty(true); }}
        disabled={isRunning}
        placeholder={'Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)'}
        className={`${textareaClass} h-[104px]`}
        spellCheck={false}
      />
      <div className="h-3.5" />
      <FieldLabel htmlFor="agent-settings-perm-deny">Denied tools, one per line</FieldLabel>
      <textarea
        id="agent-settings-perm-deny"
        value={permDeny}
        onChange={(e) => { setPermDeny(e.target.value); setPermDirty(true); }}
        disabled={isRunning}
        placeholder={'WebFetch\nBash(curl *)\nRead(./.env)'}
        className={`${textareaClass} h-[82px]`}
        spellCheck={false}
      />
    </div>
  );

  const quickDefaults = qadLoaded && (
    <>
      <Field label="Model" htmlFor="agent-settings-qad-model">
        {qadDefaultModel === 'custom' && (
          <input
            type="text"
            aria-label="Custom quick agent model"
            value={qadCustomModel}
            onChange={(e) => { setQadCustomModel(e.target.value); setQadDirty(true); }}
            placeholder="e.g. claude-opus-4-6"
            disabled={isRunning}
            spellCheck={false}
            className={`${inputClass} w-44`}
          />
        )}
        <select
          id="agent-settings-qad-model"
          value={qadDefaultModel}
          onChange={(e) => { setQadDefaultModel(e.target.value); setQadDirty(true); }}
          disabled={isRunning}
          className={selectClass}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
          <option value="custom">Custom...</option>
        </select>
      </Field>
      <Field
        label="Free Agent Mode"
        help={permissionsSupported ? 'Quick agents skip permission prompts.' : `Not supported by ${orchestratorName}.`}
      >
        <Toggle
          checked={qadFreeAgentMode}
          onChange={(v) => { setQadFreeAgentMode(v); setQadDirty(true); }}
          disabled={isRunning || !permissionsSupported}
          aria-label="Quick agent Free Agent Mode"
        />
      </Field>
      <div className="h-2.5" />
      <FieldLabel htmlFor="agent-settings-qad-prompt">Extra instructions</FieldLabel>
      <textarea
        id="agent-settings-qad-prompt"
        value={qadSystemPrompt}
        onChange={(e) => { setQadSystemPrompt(e.target.value); setQadDirty(true); }}
        disabled={isRunning}
        placeholder="Appended to the system prompt of quick agents this agent starts"
        className={`${textareaClass} h-[88px]`}
        spellCheck={false}
      />
      <div className="h-3.5" />
      <FieldLabel htmlFor="agent-settings-qad-tools">Allowed tools, one per line</FieldLabel>
      <textarea
        id="agent-settings-qad-tools"
        value={qadAllowedTools}
        onChange={(e) => { setQadAllowedTools(e.target.value); setQadDirty(true); }}
        disabled={isRunning}
        placeholder={'Bash(npm test:*)\nEdit\nWrite'}
        className={`${textareaClass} h-[82px]`}
        spellCheck={false}
      />
    </>
  );

  // Orchestration (#2232): saved by its own controls, like the Orchestration card.
  const helpersSettings = showHelpers ? <AgentHelpersSettings agent={agent} projectPath={projectPath} /> : null;

  const managedNote = (
    <p data-testid="agent-settings-managed" className="mt-3 text-[13px] text-ctp-subtext1">
      Clubhouse Mode manages this from project defaults.{' '}
      <button type="button" onClick={() => setPage('general')} className="text-ctp-accent hover:underline cursor-pointer">
        Turn on local overrides in General
      </button>{' '}
      to edit it here.
    </p>
  );

  // ── Page content ───────────────────────────────────────────────

  let body: React.ReactNode;
  if (pageMode) {
    const sub: Record<AgentSettingsPage, React.ReactNode> = {
      general: `How ${agent.name} looks and what it runs on`,
      instructions: <><span className="font-mono">{instructionsFileLabel}</span> in the agent worktree</>,
      skills: undefined,
      definitions: undefined,
      mcp: undefined,
      permissions: <span className="font-mono">{permissionsPathLabel}</span>,
      helpers: `How ${agent.name} starts, runs and disposes of helper agents. The same switches are in its Orchestration card beside the chat.`,
      quick: `Defaults for quick agents ${agent.name} starts`,
      preview: `What ${agent.name} gets at its next start`,
    };
    const builderNote = isRunning ? <span className="ml-2 text-ctp-overlay1">· Changes apply when the next session starts</span> : null;
    if (isManagedAgent && builderAgent) {
      sub.instructions = <>In the order {agent.name} reads them{builderNote}</>;
      sub.skills = <>Copied into {agent.name}'s folder at its next start{builderNote}</>;
      sub.mcp = <>Sign-in comes from your environment{builderNote}</>;
    }
    const content: Record<AgentSettingsPage, React.ReactNode> = {
      general,
      instructions: instructionsEditor,
      skills: skillsSection,
      definitions: definitionsSection,
      mcp: mcpSections,
      permissions: permissionsEditor,
      helpers: helpersSettings,
      quick: quickDefaults,
      preview: isManagedAgent && builderAgent ? <PreviewPane agent={builderAgent} /> : null,
    };
    if (isManagedAgent && builderTarget) {
      content.instructions = <ManagedBuilder target={builderTarget} tab="instructions" />;
      content.skills = <ManagedBuilder target={builderTarget} tab="skills" />;
      content.mcp = <ManagedBuilder target={builderTarget} tab="mcp" />;
    }
    // Every page stays mounted and only the selected one shows, so edits held
    // inside a page (an open skill editor, .mcp.json) survive a page switch.
    body = AGENT_SETTINGS_PAGES.filter(({ page: p }) => !hiddenPages.includes(p)).map(({ page: p, label }) => {
      // Clubhouse Mode manages files in the worktree; the orchestration policy isn't one.
      const managed = isManagedByClubhouse && !isManagedAgent && p !== 'general' && p !== 'quick' && p !== 'helpers' && p !== 'preview';
      return (
        <div key={p} data-testid={`agent-settings-page-${p}`} hidden={p !== page}>
          <PageTitle title={label} sub={sub[p]} right={p === page ? reloadButton : undefined} />
          {managed ? managedNote : content[p]}
        </div>
      );
    });
  } else if (isManagedAgent && builderAgent && builderTarget) {
    // Classic shell, managed agent: Clubhouse writes its instructions, skills and
    // MCP files at every start, so the builder takes the place of the file editors.
    const builderNote = isRunning ? 'Changes apply when the next session starts' : undefined;
    body = (
      <>
        {general}
        <div id="agent-settings-section-instructions" data-testid="agent-settings-section-instructions">
          <SectionHeading title="Instructions" sub={builderNote ?? `In the order ${agent.name} reads them`} />
          <ManagedBuilder target={builderTarget} tab="instructions" />
        </div>
        <div id="agent-settings-section-skills" data-testid="agent-settings-section-skills">
          <SectionHeading title="Skills" sub={builderNote ?? `Copied into ${agent.name}'s folder at its next start`} />
          <ManagedBuilder target={builderTarget} tab="skills" />
        </div>
        <div id="agent-settings-section-mcp" data-testid="agent-settings-section-mcp">
          <SectionHeading title="MCP servers" sub={builderNote ?? 'Sign-in comes from your environment'} />
          <ManagedBuilder target={builderTarget} tab="mcp" />
        </div>
        <div id="agent-settings-section-preview" data-testid="agent-settings-section-preview">
          <SectionHeading title="Preview" sub={`What ${agent.name} gets at its next start`} />
          <PreviewPane agent={builderAgent} />
        </div>
        {helpersSettings}
        <SectionHeading title="Quick agents" sub={`Defaults for quick agents ${agent.name} starts`} />
        {quickDefaults}
      </>
    );
  } else {
    body = (
      <>
        {general}
        {!isManagedByClubhouse && (
          <>
            <SectionHeading title="Instructions" sub={<span className="font-mono">{instructionsFileLabel}</span>} />
            {instructionsEditor}
            {skillsSection}
            {mcpSections}
            <SectionHeading title="Permissions" sub={<span className="font-mono">{permissionsPathLabel}</span>} />
            {permissionsEditor}
          </>
        )}
        {helpersSettings}
        <SectionHeading title="Quick agents" sub={`Defaults for quick agents ${agent.name} starts`} />
        {quickDefaults}
      </>
    );
  }


  return (
    <div data-testid="agent-settings" className="h-full flex flex-col bg-ctp-base overflow-hidden">
      {/* The classic shell has no breadcrumb, so it keeps a slim header to name the agent and go back. */}
      {!pageMode && (
        <div className="h-10 flex items-center gap-2.5 px-4 border-b border-surface-0 flex-shrink-0">
          <button
            type="button"
            onClick={requestCloseAgentSettings}
            className="w-7 h-7 -ml-1.5 rounded-md flex items-center justify-center text-ctp-subtext0 hover:bg-surface-0 hover:text-ctp-text cursor-pointer"
            title="Back"
            aria-label="Back"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" />
              <path d="M12 19l-7-7 7-7" />
            </svg>
          </button>
          <AgentAvatar agent={agent} size="2xs" iconUrl={iconDataUrl} />
          <span className="text-[13px] font-medium text-ctp-text truncate">{agent.name}</span>
          <span className="text-xs text-ctp-overlay1">Settings</span>
          <div className="ml-auto">{reloadButton}</div>
        </div>
      )}

      <div className="flex-[2] min-h-0 overflow-y-auto">
        <div className={`max-w-[720px] ${pageMode ? 'px-10 pt-7 pb-10' : 'px-6 pt-4 pb-10'}`}>
          {runningLine}
          {body}
        </div>
      </div>

      {barItems.length > 0 && (
        <div
          data-testid="agent-settings-save-bar"
          className={`h-12 flex-shrink-0 flex items-center gap-2 pr-6 border-t border-surface-0 bg-ctp-mantle text-[13px] ${pageMode ? 'pl-10' : 'pl-6'}`}
        >
          <span className="w-2 h-2 rounded-full flex-shrink-0 bg-ctp-warning" aria-hidden="true" />
          <span className="text-ctp-text truncate">Unsaved changes to {joinNames(barItems.map((i) => i.name))}</span>
          <div className="ml-auto flex items-center gap-1.5">
            <Button kind="quiet" onClick={handleDiscard} disabled={saving}>
              Discard
            </Button>
            <Button kind="primary" onClick={handleSaveAll} disabled={saving || isRunning} title={stopFirst}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}

      {/* Shell in worktree. In the new chrome the sidebar row opens it, so its row only shows while open. */}
      <div
        data-testid="agent-settings-shell"
        className={`flex flex-col border-t border-surface-0 ${shellOpen ? 'flex-[1] min-h-0' : ''} ${pageMode && !shellOpen ? 'hidden' : ''}`}
      >
        <button
          type="button"
          onClick={() => setShellOpen(!shellOpen)}
          aria-expanded={shellOpen}
          className="h-[30px] flex-shrink-0 w-full px-4 flex items-center gap-2 text-xs text-ctp-subtext1 hover:bg-surface-0 cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="text-ctp-overlay1 flex-shrink-0">
            <path d="M4 17l6-6-6-6" /><path d="M12 19h8" />
          </svg>
          <span className="flex-shrink-0">Shell in worktree</span>
          <span className="font-mono text-ctp-overlay1 truncate">{relativeWorktree}</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
            className={`ml-auto flex-shrink-0 transition-transform ${shellOpen ? '' : 'rotate-180'}`}>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div className={shellOpen ? 'flex-1 min-h-0' : 'h-0 overflow-hidden'}>
          {shellHasOpened && <UtilityTerminal agentId={agent.id} worktreePath={worktreePath} />}
        </div>
      </div>

      {cropImageDataUrl && (
        <ImageCropDialog
          imageDataUrl={cropImageDataUrl}
          maskShape="circle"
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}

      {cliChangeDialog}
      <ConfirmDestructiveAction
        open={pendingLeave !== null}
        title="Leave with unsaved changes?"
        description={`Your changes to ${joinNames(dirtyPageNames.map((n) => (n.startsWith('MCP') ? n : n.toLowerCase())))} will be lost.`}
        confirmLabel="Leave"
        onCancel={() => setPendingLeave(null)}
        onConfirm={() => {
          const next = pendingLeave;
          setPendingLeave(null);
          closeAgentSettings();
          next?.();
        }}
      />

      {pendingPluginTemplate && (
        <TemplateConfigDialog
          persona={{
            id: `plugin-${pendingPluginTemplate.pluginId}-${pendingPluginTemplate.template.name}`,
            name: pendingPluginTemplate.template.name,
            description: pendingPluginTemplate.template.description || '',
            content: pendingPluginTemplate.template.promptContent,
          }}
          personaColor="indigo"
          projectPath={projectPath}
          onClose={() => setPendingPluginTemplate(null)}
          onCreate={handlePluginTemplateCreate}
        />
      )}
    </div>
  );
}

/** Sections that hold their own edits. */
type SectionKey = 'mcp' | 'wildcards' | 'skills' | 'definitions';
/** Sections whose edits the save bar saves. */
type BarSectionKey = 'mcp' | 'wildcards';
const NO_SECTION_DIRTY: Record<SectionKey, boolean> = { mcp: false, wildcards: false, skills: false, definitions: false };

interface BarItem {
  key: 'wildcards' | 'instructions' | 'mcp' | 'permissions' | 'quick';
  /** How the bar and its toast name it. */
  name: string;
  save: () => Promise<void>;
  discard: () => void;
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
