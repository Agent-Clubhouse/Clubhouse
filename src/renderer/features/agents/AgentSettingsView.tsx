import { useCallback, useEffect, useState, useRef } from 'react';
import { Agent, QuickAgentDefaults, MaterializationPreview, VoiceInfo } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { useAudioStore } from '../../stores/audioStore';
import { UtilityTerminal } from './UtilityTerminal';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { SkillsSection } from './SkillsSection';
import { AgentTemplatesSection } from './AgentTemplatesSection';
import { McpJsonSection } from './McpJsonSection';

type SettingsTab = 'main' | 'quick';

interface Props {
  agent: Agent;
}

export function AgentSettingsView({ agent }: Props) {
  const isRunning = agent.status === 'running';
  const { closeAgentSettings, updateAgent } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const worktreePath = agent.worktreePath || activeProject?.path || '';
  const { options: MODEL_OPTIONS } = useModelOptions();
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));
  const { settings: audioSettings, availableVoices, loadVoices } = useAudioStore();

  // Tab state
  const [activeTab, setActiveTab] = useState<SettingsTab>('main');

  // Utility terminal collapse state
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [terminalHasOpened, setTerminalHasOpened] = useState(false);

  const handleTerminalToggle = () => {
    if (!terminalExpanded) setTerminalHasOpened(true);
    setTerminalExpanded((prev) => !prev);
  };

  // Appearance editing state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(agent.name);
  const [cropImageDataUrl, setCropImageDataUrl] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { pickAgentIcon, saveAgentIcon, removeAgentIcon, agentIcons } = useAgentStore();
  const iconDataUrl = agentIcons[agent.id];

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  useEffect(() => {
    if (audioSettings?.enabled) {
      loadVoices();
    }
  }, [audioSettings?.enabled, loadVoices]);

  const handleVoiceChange = useCallback((voiceId: string) => {
    if (voiceId === 'auto') {
      // Clear voice override - will auto-assign
      window.clubhouse.audio.speak(agent.id, '', 'status_change');
    }
  }, [agent.id]);

  const handleVoicePreview = useCallback(() => {
    const voiceId = agent.voiceConfig?.voiceId;
    if (voiceId) {
      window.clubhouse.audio.speak(agent.id, 'Hello, this is a voice preview.', 'response');
    }
  }, [agent.id, agent.voiceConfig?.voiceId]);

  const handleRenameConfirm = async () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== agent.name && activeProject) {
      await updateAgent(agent.id, { name: trimmed }, activeProject.path);
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameConfirm();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setRenameValue(agent.name);
      setIsRenaming(false);
    }
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
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { orchestrator: value });
  };

  // Agent model state
  const [agentModel, setAgentModel] = useState(agent.model || 'default');

  const handleModelChange = async (value: string) => {
    if (!projectPath) return;
    setAgentModel(value);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { model: value });
    // Update in-memory store so the agent list badge reflects immediately
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

  // Resolve orchestrator display name
  const agentOrchestrator = agent.orchestrator || 'claude-code';
  const orchestratorInfo = allOrchestrators.find((o) => o.id === agentOrchestrator);

  // Resolve capabilities for the agent's orchestrator
  const capabilities = allOrchestrators.find((o) => o.id === agentOrchestrator)?.capabilities;

  // Instructions state
  const [instructions, setInstructions] = useState('');
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsLoaded, setInstructionsLoaded] = useState(false);

  // Permissions state (main agent — stored in .claude/settings.local.json)
  const [permAllow, setPermAllow] = useState('');
  const [permDeny, setPermDeny] = useState('');
  const [permDirty, setPermDirty] = useState(false);
  const [permSaving, setPermSaving] = useState(false);
  const [permLoaded, setPermLoaded] = useState(false);

  // Free Agent Mode state (main agent)
  const [freeAgentMode, setFreeAgentMode] = useState(agent.freeAgentMode ?? false);

  // Quick Agent Defaults state
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadFreeAgentMode, setQadFreeAgentMode] = useState(false);
  const [qadDirty, setQadDirty] = useState(false);
  const [qadSaving, setQadSaving] = useState(false);
  const [qadLoaded, setQadLoaded] = useState(false);

  // Clubhouse Mode state
  const isClubhouseModeEnabled = useClubhouseModeStore((s) => s.isEnabledForProject);
  const loadClubhouseSettings = useClubhouseModeStore((s) => s.loadSettings);
  const [clubhouseModeOverride, setClubhouseModeOverride] = useState(false);
  const [preview, setPreview] = useState<MaterializationPreview | null>(null);
  const clubhouseActive = projectPath ? isClubhouseModeEnabled(projectPath) : false;
  const isManagedByClubhouse = clubhouseActive && !clubhouseModeOverride;

  useEffect(() => {
    loadClubhouseSettings();
  }, [loadClubhouseSettings]);

  // Load clubhouse mode override state from durable config
  useEffect(() => {
    if (!projectPath) return;
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
        setClubhouseModeOverride(config?.clubhouseModeOverride ?? false);
      } catch {
        // ignore
      }
    })();
  }, [projectPath, agent.id]);

  // Load materialization preview when managed
  useEffect(() => {
    if (!projectPath || !isManagedByClubhouse) {
      setPreview(null);
      return;
    }
    (async () => {
      try {
        const p = await window.clubhouse.agentSettings.previewMaterialization(projectPath, agent.id);
        setPreview(p);
      } catch {
        setPreview(null);
      }
    })();
  }, [projectPath, agent.id, isManagedByClubhouse]);

  const handleClubhouseOverrideChange = async (enabled: boolean) => {
    if (!projectPath) return;
    setClubhouseModeOverride(enabled);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { clubhouseModeOverride: enabled });
  };

  // Refresh counter — increment to force re-read from disk
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefreshAll = () => {
    setRefreshKey((k) => k + 1);
    setInstructionsDirty(false);
    setPermDirty(false);
    setQadDirty(false);
  };

  // Load quick agent defaults and agent model from config
  useEffect(() => {
    if (!projectPath) return;
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
        const defaults = config?.quickAgentDefaults;
        if (defaults) {
          setQadSystemPrompt(defaults.systemPrompt || '');
          setQadAllowedTools((defaults.allowedTools || []).join('\n'));
          setQadDefaultModel(defaults.defaultModel || '');
          setQadFreeAgentMode(defaults.freeAgentMode ?? false);
        }
        // Sync agent model and free agent mode from disk
        setAgentModel(config?.model || 'default');
        setFreeAgentMode(config?.freeAgentMode ?? false);
        setQadLoaded(true);
      } catch {
        setQadLoaded(true);
      }
    })();
  }, [projectPath, agent.id, refreshKey]);

  // Load instructions file for agent's orchestrator
  useEffect(() => {
    const readPath = worktreePath || projectPath;
    if (!readPath || !projectPath) return;
    (async () => {
      try {
        const content = await window.clubhouse.agentSettings.readInstructions(readPath, projectPath);
        setInstructions(content || '');
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
        setPermAllow((perms.allow || []).join('\n'));
        setPermDeny((perms.deny || []).join('\n'));
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
    await window.clubhouse.agentSettings.saveInstructions(writePath, instructions, projectPath);
    setInstructionsDirty(false);
    setInstructionsSaving(false);
  };

  const handleSavePermissions = async () => {
    const writePath = worktreePath || projectPath;
    if (!writePath) return;
    setPermSaving(true);
    const allow = permAllow.split('\n').map((l) => l.trim()).filter(Boolean);
    const deny = permDeny.split('\n').map((l) => l.trim()).filter(Boolean);
    await window.clubhouse.agentSettings.savePermissions(writePath, {
      allow: allow.length > 0 ? allow : undefined,
      deny: deny.length > 0 ? deny : undefined,
    }, projectPath);
    setPermDirty(false);
    setPermSaving(false);
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
  const permissionsPathLabel = conventions ? `${conventions.configDir}/${conventions.localSettingsFile}` : '.claude/settings.local.json';

  const handleSaveQad = async () => {
    if (!projectPath) return;
    setQadSaving(true);
    const defaults: QuickAgentDefaults = {};
    if (qadSystemPrompt.trim()) defaults.systemPrompt = qadSystemPrompt.trim();
    const tools = qadAllowedTools.split('\n').map((l) => l.trim()).filter(Boolean);
    if (tools.length > 0) defaults.allowedTools = tools;
    if (qadDefaultModel && qadDefaultModel !== 'default') defaults.defaultModel = qadDefaultModel;
    if (qadFreeAgentMode) defaults.freeAgentMode = true;
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { quickAgentDefaults: defaults });
    setQadDirty(false);
    setQadSaving(false);
  };

  // Check if the main tab has unsaved changes
  const mainDirty = instructionsDirty || permDirty;

  return (
    <div className="h-full flex flex-col bg-ctp-base overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-0 flex-shrink-0">
        <button
          onClick={closeAgentSettings}
          className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
          title="Back"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="relative">
          {agent.icon && iconDataUrl ? (
            <div className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
              <img src={iconDataUrl} alt={agent.name} className="w-full h-full object-cover" />
            </div>
          ) : (
            <div
              className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-bold text-white"
              style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
            >
              {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
            </div>
          )}
        </div>
        <span className="text-sm font-medium text-ctp-text">{agent.name}</span>
        <span className="text-xs text-ctp-subtext0">Settings</span>
        <div className="ml-auto">
          <button
            onClick={handleRefreshAll}
            className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer p-1"
            title="Refresh from disk"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2v6h-6" />
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
              <path d="M3 22v-6h6" />
              <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
            </svg>
          </button>
        </div>
      </div>

      {/* Running banner */}
      {isRunning && (
        <div className="px-4 py-2 bg-ctp-yellow/10 border-b border-ctp-yellow/20 text-xs text-ctp-yellow flex-shrink-0">
          Settings are read-only while this agent is running.
        </div>
      )}

      {/* Clubhouse Mode banner */}
      {clubhouseActive && (
        <div className={`px-4 py-2 border-b flex-shrink-0 ${
          isManagedByClubhouse
            ? 'bg-ctp-green/10 border-ctp-green/20'
            : 'bg-ctp-yellow/10 border-ctp-yellow/20'
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs ${isManagedByClubhouse ? 'text-ctp-green' : 'text-ctp-yellow'}`}>
              {isManagedByClubhouse
                ? 'Clubhouse Mode is active. Settings are managed from project defaults and refreshed on agent wake.'
                : 'Clubhouse Mode is active but local overrides are enabled for this agent.'}
            </span>
          </div>
          <label className="flex items-center gap-2 mt-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={clubhouseModeOverride}
              onChange={(e) => handleClubhouseOverrideChange(e.target.checked)}
              disabled={isRunning}
              className="w-3 h-3 rounded border-surface-2 bg-surface-0 accent-ctp-blue"
            />
            <span className="text-[10px] text-ctp-subtext0">Enable local overrides</span>
          </label>
        </div>
      )}

      {/* Top 2/3: scrollable settings */}
      <div className="flex-[2] overflow-y-auto min-h-0 px-4 py-4 space-y-6">
        {/* Appearance Section (shared, above tabs) */}
        <section>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Appearance</h3>
          <div className="flex items-start gap-4">
            {/* Large avatar preview */}
            {agent.icon && iconDataUrl ? (
              <div className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0">
                <img src={iconDataUrl} alt={agent.name} className="w-full h-full object-cover" />
              </div>
            ) : (
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
              >
                <span className="text-base font-bold text-white">
                  {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                </span>
              </div>
            )}

            <div className="flex-1 space-y-3">
              {/* Rename */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Name</span>
                <div className="flex gap-2 mt-1">
                  {isRenaming ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={handleRenameConfirm}
                      onKeyDown={handleRenameKeyDown}
                      className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue"
                    />
                  ) : (
                    <>
                      <span className="flex-1 text-sm text-ctp-text truncate py-1">{agent.name}</span>
                      <button
                        onClick={() => { setRenameValue(agent.name); setIsRenaming(true); }}
                        disabled={agent.status === 'running'}
                        className={`text-xs px-2 py-1 rounded transition-colors ${
                          agent.status === 'running'
                            ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed'
                            : 'bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer'
                        }`}
                        title={agent.status === 'running' ? 'Stop agent to rename' : 'Rename'}
                      >
                        Rename
                      </button>
                    </>
                  )}
                </div>
              </div>

              {/* Color picker */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Color</span>
                <div className="flex gap-2 mt-1.5">
                  {AGENT_COLORS.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => handleColorChange(c.id)}
                      disabled={isRunning}
                      className={`w-6 h-6 rounded-full transition-all ${
                        isRunning ? 'cursor-not-allowed opacity-40' :
                        agent.color === c.id ? 'ring-2 ring-offset-2 ring-offset-ctp-base scale-110 cursor-pointer' : 'opacity-60 hover:opacity-100 cursor-pointer'
                      }`}
                      style={{ backgroundColor: c.hex, ...(agent.color === c.id ? { boxShadow: `0 0 0 2px ${c.hex}40` } : {}) }}
                      title={c.label}
                    />
                  ))}
                </div>
              </div>

              {/* Icon upload */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Icon</span>
                <div className="flex gap-2 mt-1">
                  <button
                    onClick={handlePickIcon}
                    disabled={isRunning}
                    className={`px-3 py-1 text-xs rounded-lg bg-surface-0 border border-surface-2
                      text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors
                      ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    Choose Image
                  </button>
                  {agent.icon && iconDataUrl && !isRunning && (
                    <button
                      onClick={handleRemoveIcon}
                      className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:text-red-400 hover:border-red-400/50 cursor-pointer transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {/* Orchestrator */}
              {enabledOrchestrators.length > 1 ? (
                <div>
                  <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Orchestrator</span>
                  <select
                    value={agentOrchestrator}
                    onChange={(e) => handleOrchestratorChange(e.target.value)}
                    disabled={agent.status === 'running'}
                    className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {enabledOrchestrators.map((o) => (
                      <option key={o.id} value={o.id}>{o.displayName}</option>
                    ))}
                  </select>
                </div>
              ) : orchestratorInfo ? (
                <div>
                  <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Orchestrator</span>
                  <p className="mt-1 text-sm text-ctp-text">{orchestratorInfo.displayName}</p>
                </div>
              ) : null}

              {/* Model */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Model</span>
                <select
                  value={agentModel}
                  onChange={(e) => handleModelChange(e.target.value)}
                  disabled={agent.status === 'running'}
                  className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Voice */}
              {audioSettings?.enabled && (
                <div>
                  <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Voice</span>
                  <div className="flex gap-2 mt-1">
                    <select
                      value={agent.voiceConfig?.voiceId || 'auto'}
                      onChange={(e) => handleVoiceChange(e.target.value)}
                      disabled={agent.status === 'running'}
                      className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus:outline-none focus:border-ctp-blue disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="auto">Auto-assign</option>
                      {availableVoices.map((v) => (
                        <option key={v.voiceId} value={v.voiceId}>{v.voiceName} ({v.language})</option>
                      ))}
                    </select>
                    <button
                      onClick={handleVoicePreview}
                      className="px-2 py-1 text-xs rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
                      title="Preview voice"
                    >
                      ▶
                    </button>
                  </div>
                </div>
              )}

              {/* Free Agent Mode */}
              <div>
                <label
                  className={`flex items-center gap-2 ${
                    !isRunning && (capabilities?.permissions ?? false)
                      ? 'cursor-pointer'
                      : 'cursor-not-allowed opacity-50'
                  }`}
                  title={
                    !(capabilities?.permissions ?? false)
                      ? 'Not supported by this orchestrator'
                      : isRunning
                      ? 'Stop agent to change this setting'
                      : 'Skip all permission prompts when running'
                  }
                >
                  <input
                    type="checkbox"
                    checked={freeAgentMode}
                    onChange={(e) => handleFreeAgentModeChange(e.target.checked)}
                    disabled={isRunning || !(capabilities?.permissions ?? false)}
                    className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-red-500 focus:ring-red-500 accent-red-500"
                  />
                  <span className="text-sm text-ctp-text">Free Agent Mode</span>
                </label>
                {freeAgentMode && (capabilities?.permissions ?? false) && (
                  <p className="mt-1 text-[10px] text-red-400 pl-6">
                    This agent will run with full access — no tool approvals required.
                  </p>
                )}
                {!(capabilities?.permissions ?? false) && (
                  <p className="mt-1 text-[10px] text-ctp-subtext0/60 pl-6">
                    Not supported by {orchestratorInfo?.displayName || 'this orchestrator'}.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Tab Bar */}
        <div className="flex border-b border-surface-1">
          <button
            onClick={() => setActiveTab('main')}
            className={`px-4 py-2 text-xs font-medium transition-colors relative cursor-pointer ${
              activeTab === 'main'
                ? 'text-ctp-text'
                : 'text-ctp-subtext0 hover:text-ctp-text'
            }`}
          >
            Main Agent
            {mainDirty && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-ctp-blue inline-block" />
            )}
            {activeTab === 'main' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ctp-blue" />
            )}
          </button>
          <button
            onClick={() => setActiveTab('quick')}
            className={`px-4 py-2 text-xs font-medium transition-colors relative cursor-pointer ${
              activeTab === 'quick'
                ? 'text-ctp-text'
                : 'text-ctp-subtext0 hover:text-ctp-text'
            }`}
          >
            Quick Agent
            {qadDirty && (
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-ctp-blue inline-block" />
            )}
            {activeTab === 'quick' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ctp-blue" />
            )}
          </button>
        </div>

        {/* Main Agent Tab */}
        {activeTab === 'main' && (
          <div className="space-y-6">
            {/* Shared settings note */}
            <div className="text-[10px] text-ctp-subtext0/60 flex items-start gap-1.5 bg-ctp-mantle border border-surface-0 rounded-lg px-3 py-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>
                {isManagedByClubhouse
                  ? 'These values are resolved from project defaults. Wildcards have been replaced with this agent\'s actual values.'
                  : 'Skills, agent definitions, and MCP settings are stored in the agent worktree. Agents sharing the same root directory will pick up and share these settings.'}
              </span>
            </div>

            {/* Materialization Preview (read-only when managed) */}
            {isManagedByClubhouse && preview && (
              <div className="space-y-4">
                {preview.instructions && (
                  <section>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Resolved Instructions</h3>
                    <pre className="w-full bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 border border-surface-1 overflow-x-auto whitespace-pre-wrap opacity-70 max-h-40 overflow-y-auto">
                      {preview.instructions}
                    </pre>
                  </section>
                )}
                {(preview.permissions.allow?.length || preview.permissions.deny?.length) ? (
                  <section>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Resolved Permissions</h3>
                    {preview.permissions.allow && preview.permissions.allow.length > 0 && (
                      <div className="mb-2">
                        <span className="text-[10px] text-ctp-subtext0/60">Allow</span>
                        <pre className="bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-2 border border-surface-1 opacity-70">
                          {preview.permissions.allow.join('\n')}
                        </pre>
                      </div>
                    )}
                    {preview.permissions.deny && preview.permissions.deny.length > 0 && (
                      <div>
                        <span className="text-[10px] text-ctp-subtext0/60">Deny</span>
                        <pre className="bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-2 border border-surface-1 opacity-70">
                          {preview.permissions.deny.join('\n')}
                        </pre>
                      </div>
                    )}
                  </section>
                ) : null}
                {preview.mcpJson && (
                  <section>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Resolved MCP Config</h3>
                    <pre className="w-full bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 border border-surface-1 overflow-x-auto whitespace-pre-wrap opacity-70 max-h-32 overflow-y-auto">
                      {preview.mcpJson}
                    </pre>
                  </section>
                )}
                {preview.skills.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Managed Skills</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.skills.map((s) => (
                        <span key={s} className="px-2 py-0.5 text-xs bg-surface-0 border border-surface-1 rounded text-ctp-subtext0">{s}</span>
                      ))}
                    </div>
                  </section>
                )}
                {preview.agentTemplates.length > 0 && (
                  <section>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Managed Agent Templates</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {preview.agentTemplates.map((t) => (
                        <span key={t} className="px-2 py-0.5 text-xs bg-surface-0 border border-surface-1 rounded text-ctp-subtext0">{t}</span>
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}

            {/* Instructions Section (hidden when managed by clubhouse mode) */}
            {!isManagedByClubhouse && instructionsLoaded && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Instructions</h3>
                    <span className="text-[10px] text-ctp-subtext0/60 font-mono">{instructionsFileLabel}</span>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={handleOpenAgentRoot}
                      className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
                      title="Open agent root in Finder"
                    >
                      Open in Finder
                    </button>
                    <button
                      onClick={handleSaveInstructions}
                      disabled={isRunning || !instructionsDirty || instructionsSaving}
                      className={`text-xs px-3 py-1 rounded transition-colors ${
                        isRunning ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed' :
                        instructionsDirty
                          ? 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
                          : 'bg-surface-1 text-ctp-subtext0 cursor-default'
                      }`}
                    >
                      {instructionsSaving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
                <textarea
                  value={instructions}
                  onChange={(e) => { setInstructions(e.target.value); setInstructionsDirty(true); }}
                  disabled={isRunning}
                  placeholder={`Agent instructions written to ${instructionsFileLabel}...`}
                  className={`w-full h-40 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  spellCheck={false}
                />
              </section>
            )}

            {/* Skills Section (hidden when managed) */}
            {!isManagedByClubhouse && (
              <SkillsSection
                worktreePath={worktreePath}
                projectPath={projectPath}
                disabled={isRunning}
                refreshKey={refreshKey}
                pathLabel={skillsPathLabel}
              />
            )}

            {/* Agent Definitions Section (hidden when managed) */}
            {!isManagedByClubhouse && (
              <AgentTemplatesSection
                worktreePath={worktreePath}
                projectPath={projectPath}
                disabled={isRunning}
                refreshKey={refreshKey}
                pathLabel={agentTemplatesPathLabel}
              />
            )}

            {/* MCP JSON Section (hidden when managed) */}
            {!isManagedByClubhouse && (
              <McpJsonSection
                worktreePath={worktreePath}
                projectPath={projectPath}
                disabled={isRunning}
                refreshKey={refreshKey}
                pathLabel={mcpPathLabel}
              />
            )}

            {/* Permissions Section (hidden when managed) */}
            {!isManagedByClubhouse && permLoaded && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Permissions</h3>
                    <span className="text-[10px] text-ctp-subtext0/60 font-mono">{permissionsPathLabel}</span>
                  </div>
                  <button
                    onClick={handleSavePermissions}
                    disabled={isRunning || !permDirty || permSaving}
                    className={`text-xs px-3 py-1 rounded transition-colors ${
                      isRunning ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed' :
                      permDirty
                        ? 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
                        : 'bg-surface-1 text-ctp-subtext0 cursor-default'
                    }`}
                  >
                    {permSaving ? 'Saving...' : 'Save'}
                  </button>
                </div>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-ctp-subtext0 mb-1">Allowed tools (one per line)</label>
                    <textarea
                      value={permAllow}
                      onChange={(e) => { setPermAllow(e.target.value); setPermDirty(true); }}
                      disabled={isRunning}
                      placeholder={"Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)"}
                      className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                      spellCheck={false}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-ctp-subtext0 mb-1">Auto-deny tools (one per line)</label>
                    <textarea
                      value={permDeny}
                      onChange={(e) => { setPermDeny(e.target.value); setPermDirty(true); }}
                      disabled={isRunning}
                      placeholder={"WebFetch\nBash(curl *)\nRead(./.env)"}
                      className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                      spellCheck={false}
                    />
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

        {/* Quick Agent Tab */}
        {activeTab === 'quick' && qadLoaded && (
          <div className="space-y-6">
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Quick Agent Defaults</h3>
                <button
                  onClick={handleSaveQad}
                  disabled={isRunning || !qadDirty || qadSaving}
                  className={`text-xs px-3 py-1 rounded transition-colors ${
                    isRunning ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed' :
                    qadDirty
                      ? 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
                      : 'bg-surface-1 text-ctp-subtext0 cursor-default'
                  }`}
                >
                  {qadSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-ctp-subtext0 mb-1">Custom instructions</label>
                  <textarea
                    value={qadSystemPrompt}
                    onChange={(e) => { setQadSystemPrompt(e.target.value); setQadDirty(true); }}
                    disabled={isRunning}
                    placeholder="System prompt appended to quick agents spawned by this agent..."
                    className={`w-full h-28 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="block text-xs text-ctp-subtext0 mb-1">Allowed tools (one per line)</label>
                  <textarea
                    value={qadAllowedTools}
                    onChange={(e) => { setQadAllowedTools(e.target.value); setQadDirty(true); }}
                    disabled={isRunning}
                    placeholder={"Bash(npm test:*)\nEdit\nWrite"}
                    className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="block text-xs text-ctp-subtext0 mb-1">Default model</label>
                  <select
                    value={qadDefaultModel}
                    onChange={(e) => { setQadDefaultModel(e.target.value); setQadDirty(true); }}
                    disabled={isRunning}
                    className={`w-full bg-surface-0 text-ctp-text text-sm rounded-lg px-3 py-2 border border-surface-1 focus:border-ctp-blue focus:outline-none ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {MODEL_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    className={`flex items-center gap-2 ${
                      !isRunning && (capabilities?.permissions ?? false)
                        ? 'cursor-pointer'
                        : 'cursor-not-allowed opacity-50'
                    }`}
                    title={
                      !(capabilities?.permissions ?? false)
                        ? 'Not supported by this orchestrator'
                        : isRunning
                        ? 'Stop agent to change this setting'
                        : 'Default free agent mode for quick agents spawned by this agent'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={qadFreeAgentMode}
                      onChange={(e) => { setQadFreeAgentMode(e.target.checked); setQadDirty(true); }}
                      disabled={isRunning || !(capabilities?.permissions ?? false)}
                      className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-red-500 focus:ring-red-500 accent-red-500"
                    />
                    <span className="text-xs text-ctp-subtext0">Free Agent Mode by default</span>
                  </label>
                  {!(capabilities?.permissions ?? false) && (
                    <p className="mt-1 text-[10px] text-ctp-subtext0/60">
                      Not supported by {orchestratorInfo?.displayName || 'this orchestrator'}.
                    </p>
                  )}
                </div>
              </div>
            </section>
          </div>
        )}
      </div>

      {/* Bottom: collapsible utility terminal */}
      <div className={`flex flex-col border-t border-surface-0 ${terminalExpanded ? 'flex-[1] min-h-0' : ''}`}>
        <button
          onClick={handleTerminalToggle}
          className="w-full px-4 py-1.5 text-[11px] text-ctp-subtext0 bg-surface-0 border-b border-surface-1 flex items-center justify-between hover:bg-surface-1 transition-colors cursor-pointer"
        >
          <span>Utility shell</span>
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${terminalExpanded ? 'rotate-180' : ''}`}
          >
            <path d="M18 15l-6-6-6 6" />
          </svg>
        </button>
        <div className={terminalExpanded ? 'flex-1 min-h-0' : 'h-0 overflow-hidden'}>
          {terminalHasOpened && (
            <UtilityTerminal agentId={agent.id} worktreePath={worktreePath} />
          )}
        </div>
      </div>

      {/* Image crop dialog */}
      {cropImageDataUrl && (
        <ImageCropDialog
          imageDataUrl={cropImageDataUrl}
          maskShape="circle"
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
}
