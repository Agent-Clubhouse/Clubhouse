import { useEffect, useState, useRef } from 'react';
import { Agent, QuickAgentDefaults } from '../../../shared/types';
import { AGENT_COLORS } from '../../../shared/name-generator';
import { MODEL_OPTIONS } from '../../../shared/models';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { UtilityTerminal } from './UtilityTerminal';

interface Props {
  agent: Agent;
}

export function AgentSettingsView({ agent }: Props) {
  const { closeAgentSettings, updateAgent } = useAgentStore();
  const { projects, activeProjectId } = useProjectStore();
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const colorInfo = AGENT_COLORS.find((c) => c.id === agent.color);
  const worktreePath = agent.worktreePath || activeProject?.path || '';

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
  const projectPath = projects.find((p) => p.id === agent.projectId)?.path;
  const [qadSystemPrompt, setQadSystemPrompt] = useState('');
  const [qadAllowedTools, setQadAllowedTools] = useState('');
  const [qadDefaultModel, setQadDefaultModel] = useState('');
  const [qadDirty, setQadDirty] = useState(false);
  const [qadSaving, setQadSaving] = useState(false);
  const [qadLoaded, setQadLoaded] = useState(false);

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
          Utility shell
        </div>
        <div className="flex-1 min-h-0">
          <UtilityTerminal agentId={agent.id} worktreePath={worktreePath} />
        </div>
      </div>
    </div>
  );
}
