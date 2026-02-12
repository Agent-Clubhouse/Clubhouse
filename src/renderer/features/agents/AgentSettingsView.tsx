import { useEffect, useState, useCallback, useRef } from 'react';
import { Agent, McpServerEntry, SkillEntry, QuickAgentDefaults } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { MODEL_OPTIONS } from '../../../shared/models';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { UtilityTerminal } from './UtilityTerminal';

interface Props {
  agent: Agent;
}

export function AgentSettingsView({ agent }: Props) {
  const { closeAgentSettings } = useAgentStore();
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const worktreePath = agent.worktreePath as string;

  const [claudeMd, setClaudeMd] = useState('');
  const [claudeMdDirty, setClaudeMdDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mcpServers, setMcpServers] = useState<McpServerEntry[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);

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
  }, [loadData]);

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
    setSaving(true);
    await window.clubhouse.agentSettings.saveClaudeMd(worktreePath, claudeMd);
    setClaudeMdDirty(false);
    setSaving(false);
  };

  const handleRefresh = () => {
    refreshLists();
  };

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
          className="w-6 h-6 rounded-full flex-shrink-0"
          style={{ backgroundColor: colorInfo?.hex || '#6366f1' }}
        />
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
        {/* CLAUDE.md Section */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">CLAUDE.md</h3>
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
          </div>
          <textarea
            value={claudeMd}
            onChange={(e) => { setClaudeMd(e.target.value); setClaudeMdDirty(true); }}
            placeholder="# Agent instructions&#10;&#10;Add custom instructions for this agent..."
            className="w-full h-48 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
            spellCheck={false}
          />
        </section>

        {/* MCP Servers Section */}
        <section>
          <div className="flex items-center justify-between mb-2">
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
          {mcpServers.length === 0 ? (
            <div className="text-xs text-ctp-subtext0 bg-surface-0 rounded-lg p-3">
              No MCP servers configured. Use the terminal below to edit <code className="text-ctp-blue">.mcp.json</code>.
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
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold text-ctp-subtext0 uppercase tracking-wider">Skills</h3>
          </div>
          {skills.length === 0 ? (
            <div className="text-xs text-ctp-subtext0 bg-surface-0 rounded-lg p-3">
              No skills installed. Use the terminal below to add skills to <code className="text-ctp-blue">.claude/skills/</code>.
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
