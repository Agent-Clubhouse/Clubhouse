import { useEffect, useState, useRef } from 'react';
import { Agent, QuickAgentDefaults } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { UtilityTerminal } from './UtilityTerminal';

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
  const [emojiValue, setEmojiValue] = useState(agent.emoji || '');
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  const handleEmojiChange = async (value: string) => {
    setEmojiValue(value);
    if (!activeProject) return;
    // Take only the first emoji/character cluster
    const segment = [...new (Intl as any).Segmenter().segment(value)].map((s: any) => s.segment);
    const emoji = segment[0] || '';
    if (emoji !== (agent.emoji || '')) {
      await updateAgent(agent.id, { emoji: emoji || null }, activeProject.path);
    }
  };

  const handleClearEmoji = async () => {
    setEmojiValue('');
    if (!activeProject) return;
    await updateAgent(agent.id, { emoji: null }, activeProject.path);
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

  // Quick Agent Defaults state
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadDirty, setQadDirty] = useState(false);
  const [qadSaving, setQadSaving] = useState(false);
  const [qadLoaded, setQadLoaded] = useState(false);

  // Refresh counter — increment to force re-read from disk
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefreshAll = () => {
    setRefreshKey((k) => k + 1);
    setInstructionsDirty(false);
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
        }
        // Sync agent model from disk
        setAgentModel(config?.model || 'default');
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

  const handleSaveInstructions = async () => {
    const writePath = worktreePath || projectPath;
    if (!writePath || !projectPath) return;
    setInstructionsSaving(true);
    await window.clubhouse.agentSettings.saveInstructions(writePath, instructions, projectPath);
    setInstructionsDirty(false);
    setInstructionsSaving(false);
  };

  const handleOpenAgentRoot = () => {
    const rootPath = worktreePath || projectPath;
    if (rootPath) {
      window.clubhouse.file.showInFolder(rootPath);
    }
  };

  // Resolve instructions file label from orchestrator conventions
  const instructionsFileLabel = (() => {
    if (!orchestratorInfo?.conventions) return 'instructions';
    const { configDir, localInstructionsFile } = orchestratorInfo.conventions;
    // Claude Code: CLAUDE.md lives at project root, not under configDir
    if (localInstructionsFile === 'CLAUDE.md') return 'CLAUDE.md';
    return `${configDir}/${localInstructionsFile}`;
  })();

  const handleSaveQad = async () => {
    if (!projectPath) return;
    setQadSaving(true);
    const defaults: QuickAgentDefaults = {};
    if (qadSystemPrompt.trim()) defaults.systemPrompt = qadSystemPrompt.trim();
    const tools = qadAllowedTools.split('\n').map((l) => l.trim()).filter(Boolean);
    if (tools.length > 0) defaults.allowedTools = tools;
    if (qadDefaultModel && qadDefaultModel !== 'default') defaults.defaultModel = qadDefaultModel;
    await window.clubhouse.agent.updateDurableConfig(projectPath, agent.id, { quickAgentDefaults: defaults });
    setQadDirty(false);
    setQadSaving(false);
  };

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
          <div
            className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs"
            style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
          >
            {agent.emoji || ''}
          </div>
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

      {/* Top 2/3: scrollable settings */}
      <div className="flex-[2] overflow-y-auto min-h-0 px-4 py-4 space-y-6">
        {/* Appearance Section */}
        <section>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-3">Appearance</h3>
          <div className="flex items-start gap-4">
            {/* Large avatar preview */}
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
            >
              {agent.emoji ? (
                <span className="text-2xl">{agent.emoji}</span>
              ) : (
                <span className="text-base font-bold text-white">
                  {agent.name.split('-').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                </span>
              )}
            </div>

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

              {/* Emoji input */}
              <div>
                <span className="text-xs text-ctp-subtext0 uppercase tracking-wider">Emoji</span>
                <div className="flex gap-2 mt-1">
                  <input
                    value={emojiValue}
                    onChange={(e) => handleEmojiChange(e.target.value)}
                    disabled={isRunning}
                    placeholder="Paste an emoji..."
                    className={`w-24 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text text-center focus:outline-none focus:border-ctp-blue ${isRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                  {(agent.emoji || emojiValue) && !isRunning && (
                    <button
                      onClick={handleClearEmoji}
                      className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
                    >
                      Clear
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
            </div>
          </div>
        </section>

        {/* Instructions Section */}
        {instructionsLoaded && (
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

        {/* Quick Agent Defaults Section */}
        {qadLoaded && (
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
                  placeholder="Bash(npm test:*)&#10;Edit&#10;Write"
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
            </div>
          </section>
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
    </div>
  );
}
