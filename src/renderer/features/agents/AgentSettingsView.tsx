import { useEffect, useState, useRef } from 'react';
import { Agent, QuickAgentDefaults, MaterializationPreview, McpCatalogArg, McpCatalogEntry, McpCatalogEntryWithState } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { useClubhouseModeStore } from '../../stores/clubhouseModeStore';
import { UtilityTerminal } from './UtilityTerminal';
import { ImageCropDialog } from '../../components/ImageCropDialog';
import { EmojiPicker } from '../../components/EmojiPicker';
import { SkillsSection } from './SkillsSection';
import { AgentTemplatesSection } from './AgentTemplatesSection';
import { McpJsonSection } from './McpJsonSection';
import { WildcardSettingsForm } from './WildcardSettingsForm';
import { AgentAvatar } from './AgentAvatar';
import { TemplateConfigDialog, type TemplateConfig } from './TemplateConfigDialog';
import type { RegisteredPluginAgentTemplate } from '../../plugins/plugin-agent-template-registry';
import { exportAgentAsTemplate } from '../blueprints/agent-template-export';
import { serializeManifest } from '../blueprints/blueprint-export';
import { PERSONA_TEMPLATES } from '../assistant/content/personas';

type SettingsTab = 'main' | 'quick';

interface Props {
  agent: Agent;
}

function McpConfigRow({
  entry,
  checked,
  configs,
  onToggle,
  onConfigChange,
}: {
  entry: McpCatalogEntryWithState;
  checked: boolean;
  configs: Record<string, string>;
  onToggle: () => void;
  onConfigChange: (flag: string, value: string) => void;
}) {
  const hasArgs = entry.args && entry.args.length > 0;
  const [expanded, setExpanded] = useState(false);
  const isRemoved = entry.state === 'removed';

  // Detect boolean flags by description heuristic — render as toggle chips, not text inputs.
  const isBooleanFlag = (a: McpCatalogArg) =>
    !a.description || /^(enable|disable|force|use)\b/i.test(a.description);
  const booleanArgs = (entry.args || []).filter(isBooleanFlag);
  const textArgs = (entry.args || []).filter((a) => !isBooleanFlag(a));

  return (
    <div className={expanded ? 'col-span-2' : ''}>
      <div
        className={`flex items-center gap-2 py-1 px-2 rounded hover:bg-surface-0 ${
          isRemoved ? 'opacity-70' : ''
        }`}
        title={entry.description}
      >
        <label className="flex items-center gap-2 flex-1 cursor-pointer min-w-0">
          <input
            type="checkbox"
            checked={checked}
            onChange={onToggle}
            className="w-3.5 h-3.5 rounded border-surface-2 bg-surface-0 text-ctp-blue focus:ring-ctp-blue shrink-0"
          />
          <span className="text-xs text-ctp-text truncate flex items-center gap-1.5">
            {entry.name}
            {entry.state === 'new' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-ctp-green/15 text-ctp-green uppercase tracking-wider">new</span>
            )}
            {entry.state === 'changed' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-ctp-yellow/15 text-ctp-yellow uppercase tracking-wider">changed</span>
            )}
            {entry.state === 'removed' && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-ctp-red/15 text-ctp-red uppercase tracking-wider">removed</span>
            )}
          </span>
        </label>
        {hasArgs && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors shrink-0 px-1"
            title="Configure parameters"
          >
            {expanded ? '▴' : '▾'}
          </button>
        )}
      </div>
      {expanded && hasArgs && (
        <div className="mt-1.5 ml-7 mb-2 space-y-1.5">
          {textArgs.map((arg) => (
            <div key={arg.name} className="flex items-center gap-2">
              <span className="text-xs text-ctp-subtext0 font-mono w-28 text-right shrink-0 flex items-center justify-end gap-1">
                {arg.required && <span className="w-1 h-1 rounded-full bg-ctp-yellow inline-block" title="Required" />}
                {arg.name.replace(/^--/, '')}
              </span>
              <input
                type="text"
                value={configs[arg.name] || ''}
                onChange={(e) => onConfigChange(arg.name, e.target.value)}
                placeholder={arg.description || ''}
                className="flex-1 text-xs bg-surface-0 border border-surface-2 rounded px-2 py-1 text-ctp-text placeholder:text-ctp-subtext0/40 placeholder:italic focus-ring-dim transition-colors"
              />
            </div>
          ))}
          {booleanArgs.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-1">
              {booleanArgs.map((arg) => {
                const active = configs[arg.name] === 'true';
                return (
                  <button
                    key={arg.name}
                    type="button"
                    onClick={() => onConfigChange(arg.name, active ? '' : 'true')}
                    title={arg.description || ''}
                    className={`text-xs px-2 py-0.5 rounded-full border transition-colors ${
                      active
                        ? 'border-ctp-blue/50 bg-ctp-blue/15 text-ctp-blue'
                        : 'border-surface-2 text-ctp-subtext0 hover:border-ctp-subtext0'
                    }`}
                  >
                    {arg.name.replace(/^--/, '')}
                  </button>
                );
              })}
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
  const { options: MODEL_OPTIONS } = useModelOptions();
  const enabled = useOrchestratorStore((s) => s.enabled);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);
  const enabledOrchestrators = allOrchestrators.filter((o) => enabled.includes(o.id));

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
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const { pickAgentIcon, saveAgentIcon, removeAgentIcon, agentIcons } = useAgentStore();
  const iconDataUrl = agentIcons[agent.id];

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

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

  const handleStructuredModeChange = async (enabled: boolean) => {
    if (!projectPath) return;
    setStructuredMode(enabled);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { structuredMode: enabled });
    useAgentStore.setState((s) => {
      const existing = s.agents[agent.id];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [agent.id]: { ...existing, structuredMode: enabled || undefined },
        },
      };
    });
  };

  const handleOrchestratorChange = async (value: string) => {
    if (!projectPath) return;
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { orchestrator: value });
    useAgentStore.setState((s) => {
      const existing = s.agents[agent.id];
      if (!existing) return s;
      return {
        agents: {
          ...s.agents,
          [agent.id]: { ...existing, orchestrator: value },
        },
      };
    });
  };

  // Agent model state
  const isKnownModel = (id: string) => MODEL_OPTIONS.some((opt) => opt.id === id);
  const initModel = agent.model || 'default';
  const [agentModel, setAgentModel] = useState(isKnownModel(initModel) ? initModel : 'custom');
  const [agentCustomModel, setAgentCustomModel] = useState(isKnownModel(initModel) ? '' : initModel);

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

  const handleModelChange = async (value: string) => {
    setAgentModel(value);
    if (value === 'custom') {
      // Don't persist yet — wait for custom input
      setAgentCustomModel('');
    } else {
      await persistModel(value);
    }
  };

  const handleCustomModelBlur = async () => {
    const trimmed = agentCustomModel.trim();
    if (trimmed) {
      await persistModel(trimmed);
    }
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

  // Structured Mode state (main agent)
  const [structuredMode, setStructuredMode] = useState(agent.structuredMode ?? false);

  // Structured Mode is gated behind an experimental flag. When the flag is off
  // the toggle is hidden — any persisted per-agent value is preserved on disk
  // but not editable until the user opts in via experimental settings.
  const [structuredModeFlag, setStructuredModeFlag] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.clubhouse.app.getExperimentalSettings()
      .then((flags) => { if (!cancelled) setStructuredModeFlag(!!flags.structuredMode); })
      .catch(() => { /* leave disabled on failure */ });
    return () => { cancelled = true; };
  }, []);

  // Quick Agent Defaults state
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadCustomModel, setQadCustomModel] = useState('');
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
  const [preview, setPreview] = useState<MaterializationPreview | null>(null);
  const [showResolvedPreview, setShowResolvedPreview] = useState(false);
  const clubhouseActive = projectPath ? isClubhouseModeEnabled(projectPath) : false;
  const isManagedByClubhouse = clubhouseActive && !clubhouseModeOverride;

  // Persona state (per-agent override of project default)
  const [agentPersona, setAgentPersona] = useState('');

  useEffect(() => {
    loadClubhouseSettings();
  }, [loadClubhouseSettings]);

  // Load clubhouse mode override + persona from durable config
  useEffect(() => {
    if (!projectPath) return;
    (async () => {
      try {
        const config = await window.clubhouse.agent.getDurableConfig(projectPath, agent.id);
        setClubhouseModeOverride(config?.clubhouseModeOverride ?? false);
        setAgentPersona(config?.persona ?? '');
      } catch {
        // ignore
      }
    })();
  }, [projectPath, agent.id]);

  const handlePersonaChange = async (value: string) => {
    if (!projectPath) return;
    setAgentPersona(value);
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { persona: value });
  };

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

  const [exportingTemplate, setExportingTemplate] = useState(false);

  const handleExportAsTemplate = async () => {
    if (exportingTemplate) return;
    setExportingTemplate(true);
    try {
      const readPath = worktreePath || projectPath;
      let instructionContent: string | undefined;
      if (readPath && projectPath) {
        try {
          const content = await window.clubhouse.agentSettings.readInstructions(readPath, projectPath);
          if (content) instructionContent = content;
        } catch {
          // Proceed without instructions
        }
      }

      const manifest = exportAgentAsTemplate(agent, {
        instructionContent,
        mcpServers: agent.mcpIds,
      });
      const json = serializeManifest(manifest);
      await navigator.clipboard.writeText(json);
    } catch {
      // Silent failure (consistent with codebase pattern)
    } finally {
      setExportingTemplate(false);
    }
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
      const { name, color, model, orchestrator: orch, useWorktree, freeAgentMode, structuredMode, mcpIds } = templateConfig;

      // Create durable agent with user-chosen config
      const config = await window.clubhouse.agent.createDurable(
        projectPath, name, color, model !== 'default' ? model : undefined, useWorktree,
        orch, freeAgentMode || undefined, mcpIds, undefined, structuredMode || undefined,
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
        const rawJson = await window.clubhouse.agentSettings.readMcpRawJson(agentWorktree, projectPath);
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
        await window.clubhouse.agentSettings.writeMcpRawJson(agentWorktree, JSON.stringify(mcpConfig, null, 2), projectPath);
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
          setQadSystemPrompt(defaults.systemPrompt || '');
          setQadAllowedTools((defaults.allowedTools || []).join('\n'));
          const savedQadModel = defaults.defaultModel || '';
          if (savedQadModel && !isKnownModel(savedQadModel)) {
            setQadDefaultModel('custom');
            setQadCustomModel(savedQadModel);
          } else {
            setQadDefaultModel(savedQadModel);
          }
          setQadFreeAgentMode(defaults.freeAgentMode ?? false);
        }
        // Sync agent model and free agent mode from disk
        const savedModel = config?.model || 'default';
        if (isKnownModel(savedModel)) {
          setAgentModel(savedModel);
          setAgentCustomModel('');
        } else {
          setAgentModel('custom');
          setAgentCustomModel(savedModel);
        }
        setFreeAgentMode(config?.freeAgentMode ?? false);
        setStructuredMode(config?.structuredMode ?? false);
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
    const resolvedQadModel = qadDefaultModel === 'custom' ? qadCustomModel.trim() : qadDefaultModel;
    if (resolvedQadModel && resolvedQadModel !== 'default') defaults.defaultModel = resolvedQadModel;
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
        <AgentAvatar agent={agent} size="xs" iconUrl={iconDataUrl} />
        <span className="text-sm font-medium text-ctp-text">{agent.name}</span>
        <span className="text-xs text-ctp-subtext0">Settings</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleExportAsTemplate}
            disabled={exportingTemplate}
            className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer p-1 disabled:opacity-50"
            title="Export as Template (copy to clipboard)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
          </button>
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
        <div className="px-4 py-2 bg-ctp-warning/10 border-b border-ctp-warning/20 text-xs text-ctp-warning flex-shrink-0">
          Settings are read-only while this agent is running.
        </div>
      )}

      {/* Clubhouse Mode banner */}
      {clubhouseActive && (
        <div className={`px-4 py-2 border-b flex-shrink-0 ${
          isManagedByClubhouse
            ? 'bg-ctp-success/10 border-ctp-success/20'
            : 'bg-ctp-warning/10 border-ctp-warning/20'
        }`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs ${isManagedByClubhouse ? 'text-ctp-success' : 'text-ctp-warning'}`}>
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
              className="w-3 h-3 rounded border-surface-2 bg-surface-0 accent-ctp-accent"
            />
            <span className="text-xs text-ctp-subtext0">Enable local overrides</span>
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
            <AgentAvatar agent={agent} size="lg" iconUrl={iconDataUrl} />

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
                      className="flex-1 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring"
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

              {/* Icon upload / emoji */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Icon</span>
                <div className="flex gap-2 mt-1 relative">
                  <button
                    onClick={handlePickIcon}
                    disabled={isRunning}
                    className={`px-3 py-1 text-xs rounded-lg bg-surface-0 border border-surface-2
                      text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors
                      ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    Choose Image
                  </button>
                  <button
                    ref={emojiButtonRef}
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    disabled={isRunning}
                    className={`px-3 py-1 text-xs rounded-lg bg-surface-0 border border-surface-2
                      text-ctp-text hover:bg-surface-1 cursor-pointer transition-colors
                      ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    Choose Emoji
                  </button>
                  {((agent.icon && iconDataUrl) || agent.emoji) && !isRunning && (
                    <button
                      onClick={agent.emoji ? handleRemoveEmoji : handleRemoveIcon}
                      className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:text-ctp-error hover:border-ctp-error/50 cursor-pointer transition-colors"
                    >
                      Remove
                    </button>
                  )}
                  {showEmojiPicker && (
                    <div className="absolute top-8 left-0 z-dropdown">
                      <EmojiPicker
                        onSelect={handleEmojiSelect}
                        onClose={() => setShowEmojiPicker(false)}
                      />
                    </div>
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
                    className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
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
                  className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {MODEL_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>{opt.label}</option>
                  ))}
                  <option value="custom">Custom...</option>
                </select>
                {agentModel === 'custom' && (
                  <input
                    type="text"
                    value={agentCustomModel}
                    onChange={(e) => setAgentCustomModel(e.target.value)}
                    onBlur={handleCustomModelBlur}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleCustomModelBlur(); }}
                    placeholder="e.g. claude-opus-4-6"
                    disabled={agent.status === 'running'}
                    className="mt-1.5 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text placeholder:text-ctp-overlay0 focus-ring disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                )}
              </div>

              {/* Persona */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Persona</span>
                <select
                  value={agentPersona}
                  onChange={(e) => handlePersonaChange(e.target.value)}
                  className="mt-1 w-full bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text focus-ring"
                >
                  <option value="">Project default</option>
                  {PERSONA_TEMPLATES.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-ctp-subtext0/60">
                  Overrides the project default persona. Applied on the next agent wake. Effective only when Clubhouse Mode is on for this project — see <code className="bg-surface-0 px-0.5 rounded">.clubhouse/clubhouse-mode.md</code>.
                </p>
              </div>

              {/* Structured Mode (experimental — hidden unless opted in) */}
              {structuredModeFlag && (
                <div data-testid="structured-mode-field">
                  <label
                    className={`flex items-center gap-2 ${
                      !isRunning && (capabilities?.structuredMode ?? false)
                        ? 'cursor-pointer'
                        : 'cursor-not-allowed opacity-50'
                    }`}
                    title={
                      !(capabilities?.structuredMode ?? false)
                        ? 'Not supported by this orchestrator'
                        : isRunning
                        ? 'Stop agent to change this setting'
                        : 'Run in structured mode with rich event streaming'
                    }
                  >
                    <input
                      type="checkbox"
                      checked={structuredMode}
                      onChange={(e) => handleStructuredModeChange(e.target.checked)}
                      disabled={isRunning || !(capabilities?.structuredMode ?? false)}
                      className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-ctp-accent focus:ring-ctp-accent"
                    />
                    <span className="text-sm text-ctp-text">Structured Mode</span>
                  </label>
                  {structuredMode && (capabilities?.structuredMode ?? false) && (
                    <p className="mt-1 text-xs text-ctp-subtext0 pl-6">
                      This agent will run with rich event streaming instead of a PTY terminal.
                    </p>
                  )}
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
                    className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-ctp-error focus:ring-ctp-error accent-ctp-error"
                  />
                  <span className="text-sm text-ctp-text">Free Agent Mode</span>
                </label>
                {freeAgentMode && (capabilities?.permissions ?? false) && (
                  <p className="mt-1 text-xs text-ctp-error pl-6">
                    This agent will run with full access — no tool approvals required.
                  </p>
                )}
                {!(capabilities?.permissions ?? false) && (
                  <p className="mt-1 text-xs text-ctp-subtext0/60 pl-6">
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
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-ctp-accent inline-block" />
            )}
            {activeTab === 'main' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ctp-accent" />
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
              <span className="ml-1.5 w-1.5 h-1.5 rounded-full bg-ctp-accent inline-block" />
            )}
            {activeTab === 'quick' && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-ctp-accent" />
            )}
          </button>
        </div>

        {/* Main Agent Tab */}
        {activeTab === 'main' && (
          <div className="space-y-6">
            {/* Shared settings note */}
            <div className="text-xs text-ctp-subtext0/60 flex items-start gap-1.5 bg-ctp-mantle border border-surface-0 rounded-lg px-3 py-2">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
              <span>
                {isManagedByClubhouse
                  ? 'Clubhouse Mode manages this agent. Personalize it by editing the wildcard values below — saved as per-agent overrides. Enable local overrides above for the full settings editor.'
                  : 'Skills, agent definitions, and MCP settings are stored in the agent worktree. Agents sharing the same root directory will pick up and share these settings.'}
              </span>
            </div>

            {/* Per-agent wildcard settings form (editable when managed) */}
            {isManagedByClubhouse && projectPath && (
              <WildcardSettingsForm
                projectPath={projectPath}
                agentId={agent.id}
                disabled={isRunning}
                refreshKey={refreshKey}
              />
            )}

            {/* Resolved materialization preview (read-only, collapsible) */}
            {isManagedByClubhouse && preview && (
              <button
                type="button"
                onClick={() => setShowResolvedPreview((v) => !v)}
                className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer flex items-center gap-1"
              >
                <svg
                  width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className={`transition-transform ${showResolvedPreview ? 'rotate-90' : ''}`}
                >
                  <path d="M9 18l6-6-6-6" />
                </svg>
                {showResolvedPreview ? 'Hide resolved preview' : 'Show resolved preview'}
              </button>
            )}
            {isManagedByClubhouse && preview && showResolvedPreview && (
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
                        <span className="text-xs text-ctp-subtext0/60">Allow</span>
                        <pre className="bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-2 border border-surface-1 opacity-70">
                          {preview.permissions.allow.join('\n')}
                        </pre>
                      </div>
                    )}
                    {preview.permissions.deny && preview.permissions.deny.length > 0 && (
                      <div>
                        <span className="text-xs text-ctp-subtext0/60">Deny</span>
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
                    <span className="text-xs text-ctp-subtext0/60 font-mono">{instructionsFileLabel}</span>
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
                          ? 'bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer'
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
                  className={`w-full h-40 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                onCreateFromPluginTemplate={handleCreateFromPluginTemplate}
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

            {/* Launch Wrapper MCPs */}
            {!isManagedByClubhouse && mcpLoaded && mcpCatalog.length > 0 && (
              <section>
                <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-2">Launch Wrapper MCPs</h3>
                <p className="text-xs text-ctp-subtext0/60 mb-2">
                  MCPs injected via the launch wrapper when this agent starts. Expand entries to configure parameters.
                </p>
                <div className="grid grid-cols-2 gap-1">
                  {mcpCatalog.map((entry) => (
                    <McpConfigRow
                      key={entry.id}
                      entry={{ ...entry, state: 'stable' as const }}
                      checked={agentMcpIds.includes(entry.id)}
                      configs={agentMcpConfigs[entry.id] || {}}
                      onToggle={() => handleToggleMcp(entry.id)}
                      onConfigChange={(flag, value) => handleMcpConfigChange(entry.id, flag, value)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Permissions Section (hidden when managed) */}
            {!isManagedByClubhouse && permLoaded && (
              <section>
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Permissions</h3>
                    <span className="text-xs text-ctp-subtext0/60 font-mono">{permissionsPathLabel}</span>
                  </div>
                  <button
                    onClick={handleSavePermissions}
                    disabled={isRunning || !permDirty || permSaving}
                    className={`text-xs px-3 py-1 rounded transition-colors ${
                      isRunning ? 'bg-surface-1 text-ctp-subtext0/50 cursor-not-allowed' :
                      permDirty
                        ? 'bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer'
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
                      className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                      className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                      ? 'bg-ctp-accent text-white hover:bg-ctp-accent/80 cursor-pointer'
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
                    className={`w-full h-28 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
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
                    className={`w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                    spellCheck={false}
                  />
                </div>
                <div>
                  <label className="block text-xs text-ctp-subtext0 mb-1">Default model</label>
                  <select
                    value={qadDefaultModel}
                    onChange={(e) => { setQadDefaultModel(e.target.value); setQadDirty(true); }}
                    disabled={isRunning}
                    className={`w-full bg-surface-0 text-ctp-text text-sm rounded-lg px-3 py-2 border border-surface-1 focus-ring ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {MODEL_OPTIONS.map((opt) => (
                      <option key={opt.id} value={opt.id}>{opt.label}</option>
                    ))}
                    <option value="custom">Custom...</option>
                  </select>
                  {qadDefaultModel === 'custom' && (
                    <input
                      type="text"
                      value={qadCustomModel}
                      onChange={(e) => { setQadCustomModel(e.target.value); setQadDirty(true); }}
                      placeholder="e.g. claude-opus-4-6"
                      disabled={isRunning}
                      className={`mt-1.5 w-full bg-surface-0 text-ctp-text text-sm rounded-lg px-3 py-2 border border-surface-1 focus-ring placeholder:text-ctp-overlay0 ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  )}
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
                      className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-ctp-error focus:ring-ctp-error accent-ctp-error"
                    />
                    <span className="text-xs text-ctp-subtext0">Free Agent Mode by default</span>
                  </label>
                  {!(capabilities?.permissions ?? false) && (
                    <p className="mt-1 text-xs text-ctp-subtext0/60">
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

      {/* Plugin template config dialog */}
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
