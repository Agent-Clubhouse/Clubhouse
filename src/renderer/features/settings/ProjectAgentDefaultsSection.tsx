import { useEffect, useState, useCallback } from 'react';
import { SettingsMonacoEditor } from '../../components/SettingsMonacoEditor';
import type { SourceControlProvider } from '../../../shared/types';
import { SourceSkillsSection } from './SourceSkillsSection';
import { SourceAgentTemplatesSection } from './SourceAgentTemplatesSection';

interface ProjectAgentDefaults {
  instructions?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  mcpJson?: string;
  freeAgentMode?: boolean;
  sourceControlProvider?: SourceControlProvider;
}

interface Props {
  projectPath: string;
  clubhouseMode?: boolean;
}

export function ProjectAgentDefaultsSection({ projectPath, clubhouseMode }: Props) {
  const [defaults, setDefaults] = useState<ProjectAgentDefaults>({});
  const [instructions, setInstructions] = useState('');
  const [permAllow, setPermAllow] = useState('');
  const [permDeny, setPermDeny] = useState('');
  const [mcpJson, setMcpJson] = useState('');
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [sourceControlProvider, setSourceControlProvider] = useState<SourceControlProvider>('github');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const loadDefaults = useCallback(async () => {
    try {
      const d = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      setDefaults(d);
      setInstructions(d.instructions || '');
      setPermAllow((d.permissions?.allow || []).join('\n'));
      setPermDeny((d.permissions?.deny || []).join('\n'));
      setMcpJson(d.mcpJson || '');
      setFreeAgentMode(d.freeAgentMode ?? false);
      setSourceControlProvider(d.sourceControlProvider ?? 'github');
      setLoaded(true);
      setDirty(false);
    } catch {
      setLoaded(true);
    }
  }, [projectPath]);

  useEffect(() => {
    loadDefaults();
  }, [loadDefaults]);

  const handleSave = async () => {
    setSaving(true);
    const allow = permAllow.split('\n').map((l) => l.trim()).filter(Boolean);
    const deny = permDeny.split('\n').map((l) => l.trim()).filter(Boolean);

    const newDefaults: ProjectAgentDefaults = {};
    if (instructions.trim()) newDefaults.instructions = instructions;
    if (allow.length > 0 || deny.length > 0) {
      newDefaults.permissions = {};
      if (allow.length > 0) newDefaults.permissions.allow = allow;
      if (deny.length > 0) newDefaults.permissions.deny = deny;
    }
    if (mcpJson.trim()) newDefaults.mcpJson = mcpJson;
    if (freeAgentMode) newDefaults.freeAgentMode = true;
    if (sourceControlProvider !== 'github') newDefaults.sourceControlProvider = sourceControlProvider;

    await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, newDefaults);
    setDirty(false);
    setSaving(false);
  };

  if (!loaded) return null;

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">
          Default Agent Settings
        </h3>
        <button
          onClick={handleSave}
          disabled={!dirty || saving}
          className={`text-xs px-3 py-1 rounded transition-colors ${
            dirty
              ? 'bg-ctp-blue text-white hover:bg-ctp-blue/80 cursor-pointer'
              : 'bg-surface-1 text-ctp-subtext0 cursor-default'
          }`}
        >
          {saving ? 'Saving...' : 'Save Defaults'}
        </button>
      </div>

      <div className="space-y-4">
        {/* Mode note */}
        <div className={`text-[10px] flex items-start gap-1.5 rounded-lg px-3 py-2 ${
          clubhouseMode
            ? 'text-ctp-green bg-ctp-green/10 border border-ctp-green/20'
            : 'text-ctp-subtext0/60 bg-ctp-mantle border border-surface-0'
        }`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-0.5">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
          <span>
            {clubhouseMode
              ? <>
                  <strong>Clubhouse Mode active.</strong> These settings are live-managed and pushed to agent worktrees on each wake. Use wildcards: <code className="bg-ctp-green/10 px-0.5 rounded">@@AgentName</code>, <code className="bg-ctp-green/10 px-0.5 rounded">@@StandbyBranch</code>, <code className="bg-ctp-green/10 px-0.5 rounded">@@Path</code>.
                </>
              : 'These settings are applied as snapshots when new durable agents are created. Changes here do not affect existing agents.'
            }
          </span>
        </div>

        {/* Source Control Provider */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Source Control Provider</label>
          <select
            value={sourceControlProvider}
            onChange={(e) => { setSourceControlProvider(e.target.value as SourceControlProvider); setDirty(true); }}
            className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
              text-ctp-text focus:outline-none focus:border-ctp-accent/50"
          >
            <option value="github">GitHub (gh CLI)</option>
            <option value="azure-devops">Azure DevOps (az CLI)</option>
          </select>
          <p className="text-[10px] text-ctp-subtext0/60 mt-1">
            Replaces <code className="bg-surface-0 px-0.5 rounded">@@SourceControlProvider</code> in skill templates and controls conditional blocks.
          </p>
        </div>

        {/* Default Free Agent Mode */}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={freeAgentMode}
            onChange={(e) => { setFreeAgentMode(e.target.checked); setDirty(true); }}
            className="w-4 h-4 rounded border-surface-2 bg-surface-0 text-red-500 focus:ring-red-500 accent-red-500"
          />
          <span className="text-xs text-ctp-subtext0">Free Agent Mode by default</span>
        </label>
        {freeAgentMode && (
          <p className="text-[10px] text-red-400 pl-6">
            New agents will skip all permission prompts by default.
          </p>
        )}

        {/* Default instructions */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Default Instructions</label>
          <textarea
            value={instructions}
            onChange={(e) => { setInstructions(e.target.value); setDirty(true); }}
            placeholder="Default CLAUDE.md content for new agents..."
            className="w-full h-28 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
            spellCheck={false}
          />
        </div>

        {/* Default permissions */}
        <div className="space-y-2">
          <label className="block text-xs text-ctp-subtext0">Default Permissions</label>
          <div>
            <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Allowed tools (one per line)</label>
            <textarea
              value={permAllow}
              onChange={(e) => { setPermAllow(e.target.value); setDirty(true); }}
              placeholder={"Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)"}
              className="w-full h-16 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Auto-deny tools (one per line)</label>
            <textarea
              value={permDeny}
              onChange={(e) => { setPermDeny(e.target.value); setDirty(true); }}
              placeholder={"WebFetch\nBash(curl *)"}
              className="w-full h-16 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Default MCP JSON */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Default .mcp.json</label>
          <textarea
            value={mcpJson}
            onChange={(e) => { setMcpJson(e.target.value); setDirty(true); }}
            placeholder='{\n  "mcpServers": {}\n}'
            className="w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
            spellCheck={false}
          />
        </div>

        {/* Source Skills */}
        <SourceSkillsSection projectPath={projectPath} />

        {/* Source Agent Definitions */}
        <SourceAgentTemplatesSection projectPath={projectPath} />
      </div>
    </div>
  );
}
