import { useEffect, useState, useCallback, useMemo } from 'react';

import type { SourceControlProvider, ProjectConfigBreakdown, ProvenancedConfigItem } from '../../../shared/types';
import { SourceSkillsSection } from './SourceSkillsSection';
import { SourceAgentTemplatesSection } from './SourceAgentTemplatesSection';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { usePluginStore } from '../../plugins/plugin-store';

interface ProjectAgentDefaults {
  instructions?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  mcpJson?: string;
  freeAgentMode?: boolean;
  sourceControlProvider?: SourceControlProvider;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  profileId?: string;
  commandPrefix?: string;
}

interface Props {
  projectPath: string;
  clubhouseMode?: boolean;
}

// ── Provenance badge ─────────────────────────────────────────────────────

function ProvenanceBadge({ item, isOrphan }: { item: ProvenancedConfigItem; isOrphan?: boolean }) {
  const p = item.provenance;
  if (p.source === 'user') return null;
  if (p.source === 'built-in') {
    return (
      <span className="text-[9px] px-1.5 py-0.5 rounded bg-ctp-blue/15 text-ctp-blue border border-ctp-blue/20">
        built-in
      </span>
    );
  }
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
      isOrphan
        ? 'bg-ctp-peach/15 text-ctp-peach border-ctp-peach/20'
        : 'bg-ctp-mauve/15 text-ctp-mauve border-ctp-mauve/20'
    }`}>
      {isOrphan ? '(orphan) ' : ''}plugin: {p.pluginId}
    </span>
  );
}

// ── Remove button for plugin items ───────────────────────────────────────

function RemoveButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="text-ctp-subtext0 hover:text-red-400 p-0.5 cursor-pointer transition-colors disabled:opacity-30 flex-shrink-0"
      title="Remove this item"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

// ── Confirmation dialog ──────────────────────────────────────────────────

function ConfirmDialog({
  title,
  message,
  onConfirm,
  onCancel,
  confirming,
  confirmLabel = 'Remove',
  confirmingLabel = 'Removing...',
}: {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  confirmLabel?: string;
  confirmingLabel?: string;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-ctp-base border border-surface-1 rounded-xl p-6 max-w-md mx-4 shadow-xl">
        <h3 className="text-sm font-semibold text-ctp-text mb-2">{title}</h3>
        <p className="text-xs text-ctp-subtext0 mb-4">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming}
            className="px-3 py-1.5 text-xs rounded-lg bg-ctp-red text-white hover:bg-ctp-red/80 cursor-pointer transition-colors"
          >
            {confirming ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Orphan banner ────────────────────────────────────────────────────────

function OrphanBanner({
  orphanedPluginIds,
  projectPath,
  onCleaned,
}: {
  orphanedPluginIds: string[];
  projectPath: string;
  onCleaned: () => void;
}) {
  const [cleaning, setCleaning] = useState<string | null>(null);

  if (orphanedPluginIds.length === 0) return null;

  const handleClean = async (pluginId: string) => {
    setCleaning(pluginId);
    try {
      await window.clubhouse.plugin.cleanupProjectInjections(pluginId, projectPath);
      onCleaned();
    } catch { /* ignore */ } finally {
      setCleaning(null);
    }
  };

  const handleCleanAll = async () => {
    for (const id of orphanedPluginIds) {
      setCleaning(id);
      try {
        await window.clubhouse.plugin.cleanupProjectInjections(id, projectPath);
      } catch { /* ignore */ }
    }
    setCleaning(null);
    onCleaned();
  };

  return (
    <div className="p-3 rounded-lg bg-ctp-peach/5 border border-ctp-peach/30">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-ctp-peach mb-1">
            Orphaned plugin injections detected
          </p>
          <p className="text-[10px] text-ctp-subtext0 mb-2">
            These uninstalled plugins left configs in your project defaults:
          </p>
          <div className="flex flex-wrap gap-2">
            {orphanedPluginIds.map((id) => (
              <div key={id} className="flex items-center gap-1">
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-ctp-peach/20 text-ctp-peach">{id}</span>
                <button
                  onClick={() => handleClean(id)}
                  disabled={cleaning !== null}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50 transition-colors"
                >
                  {cleaning === id ? 'Cleaning...' : 'Clean up'}
                </button>
              </div>
            ))}
          </div>
        </div>
        {orphanedPluginIds.length > 1 && (
          <button
            onClick={handleCleanAll}
            disabled={cleaning !== null}
            className="shrink-0 text-[10px] px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 cursor-pointer disabled:opacity-50 transition-colors"
          >
            {cleaning ? 'Cleaning...' : 'Clean all'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Provenance-aware config item list ────────────────────────────────────

function ConfigItemList({
  items,
  orphanedPluginIds,
  onRemove,
  removing,
}: {
  items: ProvenancedConfigItem[];
  orphanedPluginIds: string[];
  onRemove: (item: ProvenancedConfigItem) => void;
  removing: string | null;
}) {
  const orphanSet = useMemo(() => new Set(orphanedPluginIds), [orphanedPluginIds]);

  if (items.length === 0) {
    return <p className="text-xs text-ctp-subtext0/60 py-1">None configured.</p>;
  }

  return (
    <div className="space-y-1">
      {items.map((item) => {
        const isPlugin = item.provenance.source === 'plugin';
        const isOrphan = isPlugin && orphanSet.has((item.provenance as { source: 'plugin'; pluginId: string }).pluginId);
        return (
          <div
            key={item.id}
            className={`flex items-center justify-between py-1.5 px-2 rounded border ${
              isOrphan
                ? 'bg-ctp-peach/5 border-ctp-peach/20'
                : 'bg-surface-0 border-surface-1'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="text-sm text-ctp-text font-mono truncate">{item.label}</span>
              <ProvenanceBadge item={item} isOrphan={isOrphan} />
            </div>
            {(isPlugin || item.provenance.source !== 'built-in') && isPlugin && (
              <RemoveButton
                onClick={() => onRemove(item)}
                disabled={removing !== null}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function ProjectAgentDefaultsSection({ projectPath, clubhouseMode }: Props) {
  const [_defaults, setDefaults] = useState<ProjectAgentDefaults>({});
  const [instructions, setInstructions] = useState('');
  const [permAllow, setPermAllow] = useState('');
  const [permDeny, setPermDeny] = useState('');
  const [mcpJson, setMcpJson] = useState('');
  const [freeAgentMode, setFreeAgentMode] = useState(false);
  const [sourceControlProvider, setSourceControlProvider] = useState<SourceControlProvider>('github');
  const [buildCommand, setBuildCommand] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [lintCommand, setLintCommand] = useState('');
  const [profileId, setProfileId] = useState<string | undefined>(undefined);
  const [commandPrefix, setCommandPrefix] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const profiles = useProfileStore((s) => s.profiles);
  const loadProfiles = useProfileStore((s) => s.loadProfiles);
  const allOrchestrators = useOrchestratorStore((s) => s.allOrchestrators);

  // Provenance breakdown state
  const [breakdown, setBreakdown] = useState<ProjectConfigBreakdown | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ProvenancedConfigItem | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Get known plugin IDs for orphan detection.
  // Select the raw plugins map (stable ref) and derive IDs in useMemo to avoid
  // the Zustand infinite loop from Object.keys() creating a new array each render.
  const pluginsMap = usePluginStore((s) => s.plugins);
  const pluginIds = useMemo(() => Object.keys(pluginsMap), [pluginsMap]);
  const pluginIdsSerialized = useMemo(() => JSON.stringify(pluginIds.slice().sort()), [pluginIds]);

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
      setBuildCommand(d.buildCommand || '');
      setTestCommand(d.testCommand || '');
      setLintCommand(d.lintCommand || '');
      setProfileId(d.profileId);
      setCommandPrefix(d.commandPrefix || '');
      setLoaded(true);
      setDirty(false);
    } catch {
      setLoaded(true);
    }
  }, [projectPath]);

  const loadBreakdown = useCallback(async () => {
    try {
      const bd = await window.clubhouse.agentSettings.getProjectConfigBreakdown(projectPath, pluginIds);
      setBreakdown(bd);
      // Use the parsed user instructions (without plugin blocks) for the editor
      setInstructions(bd.userInstructions);
    } catch {
      // Fallback — breakdown not available
    }
  }, [projectPath, pluginIdsSerialized]);

  useEffect(() => {
    loadDefaults();
    loadProfiles();
  }, [loadDefaults, loadProfiles]);

  useEffect(() => {
    if (loaded) {
      loadBreakdown();
    }
  }, [loaded, loadBreakdown]);

  const handleSave = async () => {
    setSaving(true);

    // Reconstruct full instructions: user content + preserved plugin blocks
    let fullInstructions = instructions;
    if (breakdown) {
      for (const block of breakdown.pluginInstructionBlocks) {
        if (block.provenance.source === 'plugin') {
          fullInstructions += `\n\n<!-- plugin:${block.provenance.pluginId}:start -->\n${block.value}\n<!-- plugin:${block.provenance.pluginId}:end -->`;
        }
      }
    }

    // Reconstruct permissions: user-edited rules + preserved plugin rules
    const userAllow = permAllow.split('\n').map((l) => l.trim()).filter(Boolean);
    const userDeny = permDeny.split('\n').map((l) => l.trim()).filter(Boolean);

    // Preserve plugin-tagged rules that the user didn't edit
    if (breakdown) {
      for (const rule of breakdown.allowRules) {
        if (rule.provenance.source === 'plugin') {
          userAllow.push(rule.value);
        }
      }
      for (const rule of breakdown.denyRules) {
        if (rule.provenance.source === 'plugin') {
          userDeny.push(rule.value);
        }
      }
    }

    const newDefaults: ProjectAgentDefaults = {};
    if (fullInstructions.trim()) newDefaults.instructions = fullInstructions;
    if (userAllow.length > 0 || userDeny.length > 0) {
      newDefaults.permissions = {};
      if (userAllow.length > 0) newDefaults.permissions.allow = userAllow;
      if (userDeny.length > 0) newDefaults.permissions.deny = userDeny;
    }
    if (mcpJson.trim()) newDefaults.mcpJson = mcpJson;
    if (freeAgentMode) newDefaults.freeAgentMode = true;
    if (sourceControlProvider !== 'github') newDefaults.sourceControlProvider = sourceControlProvider;
    if (buildCommand.trim()) newDefaults.buildCommand = buildCommand.trim();
    if (testCommand.trim()) newDefaults.testCommand = testCommand.trim();
    if (lintCommand.trim()) newDefaults.lintCommand = lintCommand.trim();
    if (profileId) newDefaults.profileId = profileId;
    if (commandPrefix.trim()) newDefaults.commandPrefix = commandPrefix.trim();

    await window.clubhouse.agentSettings.writeProjectAgentDefaults(projectPath, newDefaults);
    setDirty(false);
    setSaving(false);
    await loadBreakdown();
  };

  const handleReset = async () => {
    setResetting(true);
    await window.clubhouse.agentSettings.resetProjectAgentDefaults(projectPath);
    setShowResetConfirm(false);
    setResetting(false);
    await loadDefaults();
    await loadBreakdown();
  };

  const handleRemoveItem = async () => {
    if (!removeTarget) return;
    setRemoving(removeTarget.id);
    try {
      await window.clubhouse.agentSettings.removePluginInjectionItem(projectPath, removeTarget.id);
      await loadDefaults();
      await loadBreakdown();
    } catch { /* ignore */ }
    setRemoving(null);
    setRemoveTarget(null);
  };

  // Filter user-only permission rules for the editable textareas
  const userAllowRules = useMemo(() => {
    if (!breakdown) return permAllow;
    return breakdown.allowRules
      .filter((r) => r.provenance.source === 'user')
      .map((r) => r.value)
      .join('\n');
  }, [breakdown, permAllow]);

  const userDenyRules = useMemo(() => {
    if (!breakdown) return permDeny;
    return breakdown.denyRules
      .filter((r) => r.provenance.source === 'user')
      .map((r) => r.value)
      .join('\n');
  }, [breakdown, permDeny]);

  // User-only MCP servers for the editable textarea
  const userMcpJson = useMemo(() => {
    if (!breakdown || !mcpJson) return mcpJson;
    try {
      const parsed = JSON.parse(mcpJson);
      const servers = parsed.mcpServers || {};
      const userServers: Record<string, unknown> = {};
      for (const [name, config] of Object.entries(servers)) {
        const isPlugin = breakdown.mcpServers.some(
          (s) => s.label === name && s.provenance.source === 'plugin'
        );
        if (!isPlugin) {
          userServers[name] = config;
        }
      }
      if (Object.keys(userServers).length === 0 && Object.keys(servers).length > 0) {
        // All servers are plugin-managed — show empty
        return '';
      }
      return JSON.stringify({ ...parsed, mcpServers: userServers }, null, 2);
    } catch {
      return mcpJson;
    }
  }, [breakdown, mcpJson]);

  if (!loaded) return null;

  const orphanedPluginIds = breakdown?.orphanedPluginIds || [];
  const pluginAllowRules = breakdown?.allowRules.filter((r) => r.provenance.source === 'plugin') || [];
  const pluginDenyRules = breakdown?.denyRules.filter((r) => r.provenance.source === 'plugin') || [];
  const pluginMcpServers = breakdown?.mcpServers.filter((s) => s.provenance.source === 'plugin') || [];
  const hasPluginPerms = pluginAllowRules.length > 0 || pluginDenyRules.length > 0;
  const hasPluginMcp = pluginMcpServers.length > 0;

  return (
    <div className="space-y-2 mb-6">
      <div className="flex items-center justify-between">
        <h3 className="text-xs text-ctp-subtext0 uppercase tracking-wider">
          Default Agent Settings
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowResetConfirm(true)}
            className="text-xs px-3 py-1 rounded transition-colors bg-surface-1 text-ctp-subtext0 hover:bg-surface-2 hover:text-ctp-text cursor-pointer"
          >
            Reset to Defaults
          </button>
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
      </div>

      {/* Reset confirmation dialog */}
      {showResetConfirm && (
        <ConfirmDialog
          title="Reset to Defaults?"
          message="This will replace all project-level agent default settings (instructions, permissions, and commands) with the built-in defaults. Plugin-injected configs will be preserved. Any user customizations will be lost."
          onConfirm={handleReset}
          onCancel={() => setShowResetConfirm(false)}
          confirming={resetting}
          confirmLabel="Reset"
          confirmingLabel="Resetting..."
        />
      )}

      {/* Remove item confirmation dialog */}
      {removeTarget && (
        <ConfirmDialog
          title="Remove Plugin Injection?"
          message={`Remove "${removeTarget.label}" injected by plugin "${removeTarget.provenance.source === 'plugin' ? removeTarget.provenance.pluginId : 'unknown'}"? The plugin may re-inject it on next activation.`}
          onConfirm={handleRemoveItem}
          onCancel={() => setRemoveTarget(null)}
          confirming={removing !== null}
        />
      )}

      <div className="space-y-4">
        {/* Mode note */}
        <div className={`text-[10px] flex items-start gap-1.5 rounded-lg px-3 py-2 ${
          clubhouseMode
            ? 'text-ctp-success bg-ctp-success/10 border border-ctp-success/20'
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
                  <strong>Clubhouse Mode active.</strong> These settings are live-managed and pushed to agent worktrees on each wake. Use wildcards: <code className="bg-ctp-success/10 px-0.5 rounded">@@AgentName</code>, <code className="bg-ctp-success/10 px-0.5 rounded">@@StandbyBranch</code>, <code className="bg-ctp-success/10 px-0.5 rounded">@@Path</code>.
                </>
              : 'These settings are applied as snapshots when new durable agents are created. Changes here do not affect existing agents.'
            }
          </span>
        </div>

        {/* Orphan banner */}
        {orphanedPluginIds.length > 0 && (
          <OrphanBanner
            orphanedPluginIds={orphanedPluginIds}
            projectPath={projectPath}
            onCleaned={() => { loadDefaults(); loadBreakdown(); }}
          />
        )}

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

        {/* Default Profile */}
        {profiles.length > 0 && (() => {
          const activeProfile = profiles.find((p) => p.id === profileId);
          const coveredNames = activeProfile
            ? Object.keys(activeProfile.orchestrators).map(
                (id) => allOrchestrators.find((o) => o.id === id)?.displayName || id
              )
            : [];
          return (
            <div>
              <label className="block text-xs text-ctp-subtext0 mb-1">Default Profile</label>
              <select
                value={profileId || ''}
                onChange={(e) => { setProfileId(e.target.value || undefined); setDirty(true); }}
                className="w-64 px-3 py-1.5 text-sm rounded-lg bg-ctp-mantle border border-surface-2
                  text-ctp-text focus:outline-none focus:border-ctp-accent/50"
              >
                <option value="">None (default credentials)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <p className="text-[10px] text-ctp-subtext0/60 mt-1">
                Profile env vars are injected when agents in this project spawn.
                {activeProfile && ' Only orchestrators configured in the profile appear in agent creation.'}
              </p>
              {coveredNames.length > 0 && (
                <p className="text-[10px] text-ctp-accent/80 mt-1">
                  Covers: {coveredNames.join(', ')}
                </p>
              )}
            </div>
          );
        })()}

        {/* Command Prefix */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Command Prefix</label>
          <input
            value={commandPrefix}
            onChange={(e) => { setCommandPrefix(e.target.value); setDirty(true); }}
            placeholder=". ./init.sh"
            className="w-full bg-surface-0 border border-surface-1 rounded px-2 py-1.5 text-sm font-mono text-ctp-text focus:outline-none focus:border-ctp-blue"
            spellCheck={false}
          />
          <p className="text-[10px] text-ctp-subtext0/60 mt-1">
            Shell command prepended before the agent CLI binary. Use this to source environment setup scripts (e.g. <code className="bg-surface-0 px-0.5 rounded">. ./init.ps1</code>). Runs in the same shell so exported variables and PATH changes are inherited by the agent.
          </p>
        </div>

        {/* Build / Test / Lint Commands */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Project Commands</label>
          <p className="text-[10px] text-ctp-subtext0/60 mb-2">
            Configure the commands agents use to build, test, and lint your project. These replace <code className="bg-surface-0 px-0.5 rounded">@@BuildCommand</code>, <code className="bg-surface-0 px-0.5 rounded">@@TestCommand</code>, and <code className="bg-surface-0 px-0.5 rounded">@@LintCommand</code> in skills.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Build</label>
              <input
                value={buildCommand}
                onChange={(e) => { setBuildCommand(e.target.value); setDirty(true); }}
                placeholder="npm run build"
                className="w-full bg-surface-0 border border-surface-1 rounded px-2 py-1.5 text-sm font-mono text-ctp-text focus:outline-none focus:border-ctp-blue"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Test</label>
              <input
                value={testCommand}
                onChange={(e) => { setTestCommand(e.target.value); setDirty(true); }}
                placeholder="npm test"
                className="w-full bg-surface-0 border border-surface-1 rounded px-2 py-1.5 text-sm font-mono text-ctp-text focus:outline-none focus:border-ctp-blue"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Lint</label>
              <input
                value={lintCommand}
                onChange={(e) => { setLintCommand(e.target.value); setDirty(true); }}
                placeholder="npm run lint"
                className="w-full bg-surface-0 border border-surface-1 rounded px-2 py-1.5 text-sm font-mono text-ctp-text focus:outline-none focus:border-ctp-blue"
                spellCheck={false}
              />
            </div>
          </div>
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

        {/* Default instructions — user-editable portion */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Default Instructions</label>
          <textarea
            value={breakdown ? breakdown.userInstructions : instructions}
            onChange={(e) => {
              if (breakdown) {
                setBreakdown({ ...breakdown, userInstructions: e.target.value });
              }
              setInstructions(e.target.value);
              setDirty(true);
            }}
            placeholder="Default CLAUDE.md content for new agents..."
            className="w-full h-28 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
            spellCheck={false}
          />
        </div>

        {/* Plugin instruction blocks — read-only with attribution */}
        {breakdown && breakdown.pluginInstructionBlocks.length > 0 && (
          <div>
            <label className="block text-xs text-ctp-subtext0 mb-1">Plugin Instructions</label>
            <div className="space-y-2">
              {breakdown.pluginInstructionBlocks.map((block) => {
                const isOrphan = block.provenance.source === 'plugin' &&
                  orphanedPluginIds.includes(block.provenance.pluginId);
                return (
                  <div
                    key={block.id}
                    className={`rounded-lg border ${
                      isOrphan
                        ? 'bg-ctp-peach/5 border-ctp-peach/20'
                        : 'bg-ctp-mauve/5 border-ctp-mauve/20'
                    }`}
                  >
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-inherit">
                      <div className="flex items-center gap-2">
                        <ProvenanceBadge item={block} isOrphan={isOrphan} />
                      </div>
                      <RemoveButton
                        onClick={() => setRemoveTarget(block)}
                        disabled={removing !== null}
                      />
                    </div>
                    <pre className="px-3 py-2 text-[11px] text-ctp-subtext0 font-mono whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
                      {block.value}
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Default permissions — user-editable portion */}
        <div className="space-y-2">
          <label className="block text-xs text-ctp-subtext0">Default Permissions</label>
          <div>
            <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Allowed tools (one per line)</label>
            <textarea
              value={userAllowRules}
              onChange={(e) => { setPermAllow(e.target.value); setDirty(true); }}
              placeholder={"Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)"}
              className="w-full h-16 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
              spellCheck={false}
            />
          </div>
          <div>
            <label className="block text-[10px] text-ctp-subtext0/60 mb-0.5">Auto-deny tools (one per line)</label>
            <textarea
              value={userDenyRules}
              onChange={(e) => { setPermDeny(e.target.value); setDirty(true); }}
              placeholder={"WebFetch\nBash(curl *)"}
              className="w-full h-16 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Plugin permission rules — read-only with attribution */}
        {hasPluginPerms && (
          <div>
            <label className="block text-xs text-ctp-subtext0 mb-1">Plugin Permissions</label>
            {pluginAllowRules.length > 0 && (
              <div className="mb-2">
                <span className="text-[10px] text-ctp-subtext0/60">Allow rules:</span>
                <ConfigItemList
                  items={pluginAllowRules}
                  orphanedPluginIds={orphanedPluginIds}
                  onRemove={setRemoveTarget}
                  removing={removing}
                />
              </div>
            )}
            {pluginDenyRules.length > 0 && (
              <div>
                <span className="text-[10px] text-ctp-subtext0/60">Deny rules:</span>
                <ConfigItemList
                  items={pluginDenyRules}
                  orphanedPluginIds={orphanedPluginIds}
                  onRemove={setRemoveTarget}
                  removing={removing}
                />
              </div>
            )}
          </div>
        )}

        {/* Default MCP JSON — user-editable portion */}
        <div>
          <label className="block text-xs text-ctp-subtext0 mb-1">Default .mcp.json</label>
          <textarea
            value={userMcpJson}
            onChange={(e) => { setMcpJson(e.target.value); setDirty(true); }}
            placeholder='{\n  "mcpServers": {}\n}'
            className="w-full h-20 bg-surface-0 text-ctp-text text-sm font-mono rounded-lg p-3 resize-y border border-surface-1 focus:border-ctp-blue focus:outline-none"
            spellCheck={false}
          />
        </div>

        {/* Plugin MCP servers — read-only with attribution */}
        {hasPluginMcp && (
          <div>
            <label className="block text-xs text-ctp-subtext0 mb-1">Plugin MCP Servers</label>
            <ConfigItemList
              items={pluginMcpServers}
              orphanedPluginIds={orphanedPluginIds}
              onRemove={setRemoveTarget}
              removing={removing}
            />
          </div>
        )}

        {/* Source Skills — with provenance badges above the editor */}
        {breakdown && breakdown.skills.length > 0 && (
          <div>
            <label className="block text-xs text-ctp-subtext0 mb-1">Managed Skills</label>
            <ConfigItemList
              items={breakdown.skills}
              orphanedPluginIds={orphanedPluginIds}
              onRemove={setRemoveTarget}
              removing={removing}
            />
          </div>
        )}
        <SourceSkillsSection projectPath={projectPath} />

        {/* Source Agent Definitions — with provenance badges above the editor */}
        {breakdown && breakdown.agentTemplates.length > 0 && (
          <div>
            <label className="block text-xs text-ctp-subtext0 mb-1">Managed Agent Definitions</label>
            <ConfigItemList
              items={breakdown.agentTemplates}
              orphanedPluginIds={orphanedPluginIds}
              onRemove={setRemoveTarget}
              removing={removing}
            />
          </div>
        )}
        <SourceAgentTemplatesSection projectPath={projectPath} />
      </div>
    </div>
  );
}
