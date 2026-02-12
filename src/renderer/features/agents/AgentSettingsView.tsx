import { useEffect, useState, useCallback, useRef } from 'react';
import { Agent, McpServerEntry, SkillEntry, DurableAgentConfig, ConfigItemKey, OverrideFlags, PermissionsConfig, QuickAgentDefaults } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { MODEL_OPTIONS } from '../../../shared/models';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { UtilityTerminal } from './UtilityTerminal';
import { ConfigOverrideToggle } from '../settings/ConfigOverrideToggle';
import { PermissionsEditor } from '../settings/PermissionsEditor';

interface Props {
  agent: Agent;
}

const DEFAULT_OVERRIDES: OverrideFlags = {
  claudeMd: false,
  permissions: false,
  mcpConfig: false,
  skills: false,
  agents: false,
};

export function AgentSettingsView({ agent }: Props) {
  const { closeAgentSettings, updateAgent } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const worktreePath = agent.worktreePath as string;

  const [claudeMd, setClaudeMd] = useState('');
  const [claudeMdDirty, setClaudeMdDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [overrides, setOverrides] = useState<OverrideFlags>(DEFAULT_OVERRIDES);
  const [permissions, setPermissions] = useState<PermissionsConfig>({});

  // Load override flags from agent config
  const loadOverrides = useCallback(async () => {
    if (!activeProject) return;
    const configs: DurableAgentConfig[] = await window.clubhouse.agent.listDurable(activeProject.path);
    const config = configs.find((c) => c.id === agent.id);
    if (config?.overrides) {
      setOverrides(config.overrides);
    }
  }, [activeProject, agent.id]);

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

  // Quick Agent Defaults state
  const projects = useProjectStore((s) => s.projects);
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadDirty, setQadDirty] = useState(false);
  const [qadSaving, setQadSaving] = useState(false);
  const [qadLoaded, setQadLoaded] = useState(false);

  // Refresh only MCP + skills (won't clobber unsaved CLAUDE.md edits)
  const refreshLists = useCallback(async () => {
    const [servers, skillList] = await Promise.all([
      window.clubhouse.agentSettings.readMcpConfig(worktreePath),
      window.clubhouse.agentSettings.listSkills(worktreePath),
    ]);
    setMcpServers(servers);
    setSkills(skillList);
  }, [worktreePath]);

  // Full load (including CLAUDE.md)
  const loadData = useCallback(async () => {
    const [md, servers, skillList] = await Promise.all([
      window.clubhouse.agentSettings.readClaudeMd(worktreePath),
      window.clubhouse.agentSettings.readMcpConfig(worktreePath),
      window.clubhouse.agentSettings.listSkills(worktreePath),
    ]);
    setClaudeMd(md);
    setClaudeMdDirty(false);
    setMcpServers(servers);
    setSkills(skillList);
  }, [worktreePath]);

  useEffect(() => {
    loadData();
    loadOverrides();
  }, [loadData, loadOverrides]);

  // Load quick agent defaults
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
        setQadLoaded(true);
      } catch {
        setQadLoaded(true);
      }
    })();
  }, [projectPath, agent.id]);

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

  // Auto-refresh: listen for utility terminal PTY activity, debounce refresh
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utilityPtyId = `utility_${agent.id}`;

  useEffect(() => {
    const removeListener = window.clubhouse.pty.onData((id: string) => {
      if (id !== utilityPtyId) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        refreshLists();
      }, 1500);
    });

    return () => {
      removeListener();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [utilityPtyId, refreshLists]);

  const handleSaveClaudeMd = async () => {
    if (!activeProject) return;
    setSaving(true);
    await window.clubhouse.agentSettings.saveClaudeMd(worktreePath, claudeMd, activeProject.path, agent.id);
    setClaudeMdDirty(false);
    setSaving(false);
    // Reload overrides since saving may auto-set claudeMd override to true
    loadOverrides();
  };

  const handleRefresh = () => {
    refreshLists();
  };

  const handleToggleOverride = async (key: ConfigItemKey, synced: boolean) => {
    if (!activeProject) return;
    const result = await window.clubhouse.agent.toggleOverride(activeProject.path, agent.id, key, !synced);
    if (result?.overrides) {
      setOverrides(result.overrides);
      // Reload data since toggling may have changed file contents
      loadData();
    }
  };

  const claudeMdSynced = !overrides.claudeMd;
  const permissionsSynced = !overrides.permissions;
  const mcpSynced = !overrides.mcpConfig;
  const skillsSynced = !overrides.skills;

  return (
    <div className="h-full flex flex-col bg-ctp-base">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-surface-0">
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
        <div
          className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-xs"
          style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
        >
          {agent.emoji || ''}
        </div>
        <span className="text-sm font-medium text-ctp-text">{agent.name}</span>
        <span className="text-xs text-ctp-subtext0">Settings</span>
        <div className="flex-1" />
        <button
          onClick={handleRefresh}
          title="Refresh MCP servers and skills"
          className="text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6" />
            <path d="M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
            <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
          </svg>
        </button>
      </div>

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
                      className={`w-6 h-6 rounded-full cursor-pointer transition-all ${
                        agent.color === c.id ? 'ring-2 ring-offset-2 ring-offset-ctp-base scale-110' : 'opacity-60 hover:opacity-100'
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
                    placeholder="Paste an emoji..."
                    className="w-24 bg-surface-0 border border-surface-2 rounded px-2 py-1 text-sm text-ctp-text text-center focus:outline-none focus:border-ctp-blue"
                  />
                  {(agent.emoji || emojiValue) && (
                    <button
                      onClick={handleClearEmoji}
                      className="text-xs px-2 py-1 rounded bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CLAUDE.md Section */}
        <section>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">CLAUDE.md</h3>
            {!claudeMdSynced && (
              <button
                onClick={handleSaveClaudeMd}
                disabled={!claudeMdDirty || saving}
                className={`text-xs px-3 py-1 rounded transition-colors cursor-pointer ${
                  claudeMdDirty
                    ? 'bg-ctp-blue text-ctp-base hover:bg-ctp-blue/80'
                    : 'bg-surface-1 text-ctp-subtext0 cursor-default'
                }`}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
          <ConfigOverrideToggle
            label="CLAUDE.md"
            synced={claudeMdSynced}
            onToggle={(synced) => handleToggleOverride('claudeMd', synced)}
          />
          {claudeMdSynced ? (
            <div className="bg-surface-0 rounded-lg p-3 border border-surface-1">
              <div className="text-[10px] text-ctp-green uppercase tracking-wider mb-1">Managed by project</div>
              <pre className="text-xs text-ctp-subtext0 font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
                {claudeMd || '(empty)'}
              </pre>
            </div>
          ) : (
            <textarea
              value={claudeMd}
              onChange={(e) => { setClaudeMd(e.target.value); setClaudeMdDirty(true); }}
              placeholder="# Agent instructions&#10;&#10;Add custom instructions for this agent..."
              className="w-full h-48 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
              spellCheck={false}
            />
          )}
        </section>

        {/* Permissions Section */}
        <section>
          <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider mb-1">Permissions</h3>
          <ConfigOverrideToggle
            label="Permissions"
            synced={permissionsSynced}
            onToggle={(synced) => handleToggleOverride('permissions', synced)}
          />
          {permissionsSynced ? (
            <div className="bg-surface-0 rounded-lg p-3 border border-surface-1">
              <div className="text-[10px] text-ctp-green uppercase tracking-wider mb-1">Managed by project</div>
              <div className="text-xs text-ctp-subtext0">Permission rules are synced from project defaults.</div>
            </div>
          ) : (
            <PermissionsEditor
              value={permissions}
              onChange={setPermissions}
            />
          )}
        </section>

        {/* MCP Servers Section */}
        <section>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">MCP Servers</h3>
            <button
              onClick={handleRefresh}
              title="Refresh"
              className="text-xs text-ctp-subtext0 hover:text-ctp-text transition-colors cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6" />
                <path d="M1 20v-6h6" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
              </svg>
            </button>
          </div>
          <ConfigOverrideToggle
            label="MCP"
            synced={mcpSynced}
            onToggle={(synced) => handleToggleOverride('mcpConfig', synced)}
          />
          {mcpSynced && (
            <div className="text-[10px] text-ctp-green uppercase tracking-wider mb-2">Managed by project</div>
          )}
          {mcpServers.length === 0 ? (
            <div className="text-xs text-ctp-subtext0 bg-surface-0 rounded-lg p-3">
              No MCP servers configured. {!mcpSynced && <>Use the terminal below to edit <code className="text-ctp-blue">.mcp.json</code>.</>}
            </div>
          ) : (
            <div className="space-y-2">
              {mcpServers.map((server) => (
                <div key={server.name} className="bg-surface-0 rounded-lg px-3 py-2 border border-surface-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ctp-text font-medium">{server.name}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                      server.scope === 'project'
                        ? 'bg-ctp-green/15 text-ctp-green'
                        : 'bg-surface-2 text-ctp-subtext0'
                    }`}>
                      {server.scope === 'project' ? 'project' : 'global'}
                    </span>
                  </div>
                  <div className="text-xs text-ctp-subtext0 font-mono mt-0.5">
                    {server.command}{server.args ? ` ${server.args.join(' ')}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Skills Section */}
        <section>
          <div className="flex items-center justify-between mb-1">
            <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Skills</h3>
          </div>
          <ConfigOverrideToggle
            label="Skills"
            synced={skillsSynced}
            onToggle={(synced) => handleToggleOverride('skills', synced)}
          />
          {skillsSynced && (
            <div className="text-[10px] text-ctp-green uppercase tracking-wider mb-2">Managed by project</div>
          )}
          {skills.length === 0 ? (
            <div className="text-xs text-ctp-subtext0 bg-surface-0 rounded-lg p-3">
              No skills installed. {!skillsSynced && <>Use the terminal below to add skills to <code className="text-ctp-blue">.claude/skills/</code>.</>}
            </div>
          ) : (
            <div className="space-y-2">
              {skills.map((skill) => (
                <div key={skill.name} className="bg-surface-0 rounded-lg px-3 py-2 border border-surface-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ctp-text font-medium">{skill.name}</span>
                    {skill.hasReadme && (
                      <span className="text-[10px] bg-surface-2 text-ctp-subtext0 px-1.5 py-0.5 rounded">README</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Quick Agent Defaults Section */}
        {qadLoaded && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Quick Agent Defaults</h3>
              <button
                onClick={handleSaveQad}
                disabled={!qadDirty || qadSaving}
                className={`text-xs px-3 py-1 rounded transition-colors cursor-pointer ${
                  qadDirty
                    ? 'bg-ctp-blue text-ctp-base hover:bg-ctp-blue/80'
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
                  placeholder="System prompt appended to quick agents spawned by this agent..."
                  className="w-full h-28 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="block text-xs text-ctp-subtext0 mb-1">Allowed tools (one per line)</label>
                <textarea
                  value={qadAllowedTools}
                  onChange={(e) => { setQadAllowedTools(e.target.value); setQadDirty(true); }}
                  placeholder="Bash(npm test:*)&#10;Edit&#10;Write"
                  className="w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
                  spellCheck={false}
                />
              </div>
              <div>
                <label className="block text-xs text-ctp-subtext0 mb-1">Default model</label>
                <select
                  value={qadDefaultModel}
                  onChange={(e) => { setQadDefaultModel(e.target.value); setQadDirty(true); }}
                  className="w-full bg-surface-0 text-ctp-text text-sm rounded-lg px-3 py-2 border border-surface-1 focus:border-ctp-blue focus:outline-none"
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

      {/* Bottom 1/3: utility terminal */}
      <div className="flex-[1] min-h-0 flex flex-col border-t border-surface-0">
        <div className="px-4 py-1.5 text-[11px] text-ctp-subtext0 bg-surface-0 border-b border-surface-1">
          Utility shell — use <code className="text-ctp-blue">claude mcp add -s project</code> to install MCPs to this agent
        </div>
        <div className="flex-1 min-h-0">
          <UtilityTerminal agentId={agent.id} worktreePath={worktreePath} />
        </div>
      </div>
    </div>
  );
}
