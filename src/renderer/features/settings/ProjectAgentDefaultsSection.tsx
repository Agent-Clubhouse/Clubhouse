import { useEffect, useId, useState, useCallback, useMemo, type ReactNode } from 'react';

import type { SourceControlProvider, ProjectConfigBreakdown, ProvenancedConfigItem } from '../../../shared/types';
import { SourceSkillsSection } from './SourceSkillsSection';
import { SourceAgentTemplatesSection } from './SourceAgentTemplatesSection';
import { useProfileStore } from '../../stores/profileStore';
import { useOrchestratorStore } from '../../stores/orchestratorStore';
import { usePluginStore } from '../../plugins/plugin-store';
import { PERSONA_TEMPLATES } from '../personas';
import { Toggle } from '../../components/Toggle';
import { Modal } from '../../components/Modal';
import {
  SettingsSection, SettingsField, SettingsBlock,
  settingsInput, settingsTextArea, settingsLabel, settingsHelp,
} from './SettingsLayout';
import { Button } from '../../components/Button';

const CODE_CLASS = 'font-mono text-ctp-subtext1';
const SELECT_CLASS = `${settingsInput} w-[220px]`;
const TEXT_INPUT_CLASS = `${settingsInput} w-[220px] font-mono`;
const CLUBHOUSE_WILDCARDS = [
  '@@AgentName', '@@StandbyBranch', '@@Path', '@@BuildCommand', '@@TestCommand',
  '@@LintCommand', '@@SourceControlProvider', '@@Mission', '@@Persona',
];

function Code({ children }: { children: ReactNode }) {
  return <code className={CODE_CLASS}>{children}</code>;
}

interface ProjectAgentDefaults {
  instructions?: string;
  permissions?: { allow?: string[]; deny?: string[] };
  mcpJson?: string;
  freeAgentMode?: boolean;
  sourceControlProvider?: SourceControlProvider;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  mission?: string;
  persona?: string;
  profileId?: string;
  commandPrefix?: string;
}

interface Props {
  projectPath: string;
  clubhouseMode?: boolean;
}

// ── Provenance meta text ─────────────────────────────────────────────────

function ProvenanceMeta({ item, isOrphan }: { item: ProvenancedConfigItem; isOrphan?: boolean }) {
  const p = item.provenance;
  if (p.source === 'user') return null;
  if (p.source === 'built-in') {
    return <span className="text-xs text-ctp-overlay1">Built-in</span>;
  }
  return (
    <span className={`text-xs ${isOrphan ? 'text-ctp-warning' : 'text-ctp-overlay1'}`}>
      {isOrphan ? 'Orphaned plugin' : 'Plugin'} <span className="font-mono">{p.pluginId}</span>
    </span>
  );
}

// ── Remove button for plugin items ───────────────────────────────────────

function RemoveButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      kind="quiet" className="w-7 px-0 text-ctp-subtext0 hover:text-ctp-error flex-shrink-0"
      title="Remove this item"
      aria-label="Remove this item"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </Button>
  );
}

// ── Confirmation dialog ──────────────────────────────────────────────────

function ConfirmDialog({
  open,
  title,
  message,
  onConfirm,
  onCancel,
  confirming,
  confirmLabel = 'Remove',
  confirmingLabel = 'Removing…',
  testId,
}: {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirming?: boolean;
  confirmLabel?: string;
  confirmingLabel?: string;
  testId?: string;
}) {
  return (
    <Modal open={open} onClose={onCancel} title={title} width="w-[420px] max-w-[calc(100vw-32px)]" footer={
      <>
        <Button onClick={onCancel} kind="ghost">
          Cancel
        </Button>
        <Button onClick={onConfirm} disabled={confirming} kind="danger-solid">
          {confirming ? confirmingLabel : confirmLabel}
        </Button>
      </>
    }>
      <div data-testid={testId}>
        <p className={settingsHelp}>{message}</p>
      </div>
    </Modal>
  );
}

// ── Orphaned plugin injections ───────────────────────────────────────────

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
    <div data-testid="orphan-plugin-injections">
      <SettingsField
        label={<span className="text-ctp-warning">Orphaned plugin injections</span>}
        help="These uninstalled plugins left configs in your project defaults."
      >
        {orphanedPluginIds.length > 1 && (
          <Button onClick={handleCleanAll} disabled={cleaning !== null} kind="danger">
            {cleaning ? 'Cleaning…' : 'Clean all'}
          </Button>
        )}
      </SettingsField>
      {orphanedPluginIds.map((id) => (
        <div key={id} className="flex items-center gap-4 h-[34px] pl-5 border-t border-surface-0">
          <span className="flex-1 min-w-0 truncate text-xs font-mono text-ctp-text">{id}</span>
          <Button onClick={() => handleClean(id)} disabled={cleaning !== null} kind="ghost">
            {cleaning === id ? 'Cleaning…' : 'Clean up'}
          </Button>
        </div>
      ))}
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
    return <p className={`${settingsHelp} py-1`}>None configured.</p>;
  }

  return (
    <div>
      {items.map((item) => {
        const isPlugin = item.provenance.source === 'plugin';
        const isOrphan = isPlugin && orphanSet.has((item.provenance as { source: 'plugin'; pluginId: string }).pluginId);
        return (
          <div key={item.id} className="flex items-center gap-3 min-h-[34px] border-t border-surface-0">
            <div className="flex items-baseline gap-2 min-w-0 flex-1">
              <span className="text-xs text-ctp-text font-mono truncate">{item.label}</span>
              <ProvenanceMeta item={item} isOrphan={isOrphan} />
            </div>
            {isPlugin && (
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
  const [mission, setMission] = useState('');
  const [persona, setPersona] = useState('');
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
  const idBase = useId();

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
      setMission(d.mission || '');
      setPersona(d.persona || '');
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
    if (mission.trim()) newDefaults.mission = mission.trim();
    if (persona) newDefaults.persona = persona;
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

  const activeProfile = profiles.find((p) => p.id === profileId);
  const coveredNames = activeProfile
    ? Object.keys(activeProfile.orchestrators).map(
        (id) => allOrchestrators.find((o) => o.id === id)?.displayName || id
      )
    : [];
  const markDirty = () => setDirty(true);

  return (
    <div data-testid="project-agent-defaults-section">
      <SettingsSection
        title="Default agent settings"
        actions={
          <>
            <Button onClick={() => setShowResetConfirm(true)} kind="quiet">
              Reset to defaults
            </Button>
            <Button onClick={handleSave} disabled={!dirty || saving} kind="primary">
              {saving ? 'Saving…' : 'Save defaults'}
            </Button>
          </>
        }
      >
        <p className={`${settingsHelp} mb-2`}>
          {clubhouseMode
            ? 'Clubhouse Mode is on. These settings are live-managed and pushed to agent worktrees each time an agent wakes.'
            : 'These settings are applied as snapshots when new durable agents are created. Changes here do not affect existing agents.'}
        </p>
        {clubhouseMode && (
          <div className="mb-2">
            <p className="text-xs flex flex-wrap gap-x-2.5 gap-y-0.5">
              {CLUBHOUSE_WILDCARDS.map((w) => <Code key={w}>{w}</Code>)}
            </p>
            <p className={`${settingsHelp} mt-1`}>
              Full reference in <Code>.clubhouse/clubhouse-mode.md</Code> in this project.
            </p>
          </div>
        )}

        {orphanedPluginIds.length > 0 && (
          <OrphanBanner
            orphanedPluginIds={orphanedPluginIds}
            projectPath={projectPath}
            onCleaned={() => { loadDefaults(); loadBreakdown(); }}
          />
        )}

        <SettingsField
          label="Source control provider"
          help={<>Replaces <Code>@@SourceControlProvider</Code> in skill templates and controls conditional blocks.</>}
          htmlFor={`${idBase}-scp`}
        >
          <select
            id={`${idBase}-scp`}
            value={sourceControlProvider}
            onChange={(e) => { setSourceControlProvider(e.target.value as SourceControlProvider); markDirty(); }}
            className={SELECT_CLASS}
          >
            <option value="github">GitHub (gh CLI)</option>
            <option value="azure-devops">Azure DevOps (az CLI)</option>
          </select>
        </SettingsField>

        {profiles.length > 0 && (
          <SettingsField
            label="Default profile"
            help={
              <>
                Profile env vars are injected when agents in this project start.
                {activeProfile && ' Agent creation only offers the orchestrators the profile configures.'}
                {coveredNames.length > 0 && <span className="block mt-px">Covers {coveredNames.join(', ')}.</span>}
              </>
            }
            htmlFor={`${idBase}-profile`}
          >
            <select
              id={`${idBase}-profile`}
              value={profileId || ''}
              onChange={(e) => { setProfileId(e.target.value || undefined); markDirty(); }}
              className={SELECT_CLASS}
            >
              <option value="">None (default credentials)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </SettingsField>
        )}

        <SettingsField
          label="Command prefix"
          help={<>Shell command run before the agent CLI, like <Code>. ./init.ps1</Code>. It runs in the same shell, so exported variables and PATH changes reach the agent.</>}
          htmlFor={`${idBase}-prefix`}
        >
          <input
            id={`${idBase}-prefix`}
            value={commandPrefix}
            onChange={(e) => { setCommandPrefix(e.target.value); markDirty(); }}
            placeholder=". ./init.sh"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>

        <SettingsField
          label="Default mission"
          help={
            <>
              ID of a markdown file in <Code>.clubhouse/missions/</Code>, like <Code>implement-and-ship</Code>. Its content
              replaces <Code>@@Mission</Code> in instructions, skills and permissions. An agent&apos;s own <Code>mission</Code> in{' '}
              <Code>.clubhouse/agents.json</Code> wins. Leave blank for no mission.
            </>
          }
          htmlFor={`${idBase}-mission`}
        >
          <input
            id={`${idBase}-mission`}
            value={mission}
            onChange={(e) => { setMission(e.target.value); markDirty(); }}
            placeholder="implement-and-ship"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>

        <SettingsField
          label="Default persona"
          help={
            <>
              Used by every agent in this project that has no persona of its own. Override it in agent settings or in{' '}
              <Code>.clubhouse/agents.json</Code> (see <Code>.clubhouse/clubhouse-mode.md</Code>). Resolves
              to <Code>@@Persona</Code>, and is appended to CLAUDE.md when the template lacks that token.
            </>
          }
          htmlFor={`${idBase}-persona`}
        >
          <select
            id={`${idBase}-persona`}
            value={persona}
            onChange={(e) => { setPersona(e.target.value); markDirty(); }}
            className={SELECT_CLASS}
          >
            <option value="">None</option>
            {PERSONA_TEMPLATES.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </SettingsField>

        <SettingsField
          label="Free agent mode by default"
          help={freeAgentMode
            ? <span className="text-ctp-error">New agents will skip all permission prompts by default.</span>
            : 'Start new agents with permission prompts skipped.'}
        >
          <Toggle
            aria-label="Free agent mode by default"
            checked={freeAgentMode}
            onChange={(v) => { setFreeAgentMode(v); markDirty(); }}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Project commands">
        <p className={`${settingsHelp} mb-2`}>
          Commands agents use to build, test and lint the project. They replace <Code>@@BuildCommand</Code>,{' '}
          <Code>@@TestCommand</Code> and <Code>@@LintCommand</Code> in skills.
        </p>
        <SettingsField label="Build" htmlFor={`${idBase}-build`}>
          <input
            id={`${idBase}-build`}
            value={buildCommand}
            onChange={(e) => { setBuildCommand(e.target.value); markDirty(); }}
            placeholder="npm run build"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>
        <SettingsField label="Test" htmlFor={`${idBase}-test`}>
          <input
            id={`${idBase}-test`}
            value={testCommand}
            onChange={(e) => { setTestCommand(e.target.value); markDirty(); }}
            placeholder="npm test"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>
        <SettingsField label="Lint" htmlFor={`${idBase}-lint`}>
          <input
            id={`${idBase}-lint`}
            value={lintCommand}
            onChange={(e) => { setLintCommand(e.target.value); markDirty(); }}
            placeholder="npm run lint"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Default instructions">
        <SettingsBlock>
          <textarea
            aria-label="Default instructions"
            value={breakdown ? breakdown.userInstructions : instructions}
            onChange={(e) => {
              if (breakdown) {
                setBreakdown({ ...breakdown, userInstructions: e.target.value });
              }
              setInstructions(e.target.value);
              markDirty();
            }}
            placeholder="Default CLAUDE.md content for new agents…"
            className={`${settingsTextArea} h-28`}
            spellCheck={false}
          />
        </SettingsBlock>

        {/* Plugin instruction blocks: read-only with attribution */}
        {breakdown && breakdown.pluginInstructionBlocks.length > 0 && (
          <SettingsBlock>
            <div className={settingsLabel}>Plugin instructions</div>
            {breakdown.pluginInstructionBlocks.map((block) => {
              const isOrphan = block.provenance.source === 'plugin' &&
                orphanedPluginIds.includes(block.provenance.pluginId);
              return (
                <div key={block.id} className="border-t border-surface-0">
                  <div className="flex items-center justify-between min-h-[34px]">
                    <ProvenanceMeta item={block} isOrphan={isOrphan} />
                    <RemoveButton
                      onClick={() => setRemoveTarget(block)}
                      disabled={removing !== null}
                    />
                  </div>
                  <pre className="pb-2 text-[11px] text-ctp-subtext0 font-mono whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
                    {block.value}
                  </pre>
                </div>
              );
            })}
          </SettingsBlock>
        )}
      </SettingsSection>

      <SettingsSection title="Default permissions">
        <SettingsBlock className="space-y-2.5">
          <div>
            <label htmlFor={`${idBase}-allow`} className={settingsLabel}>Allowed tools, one per line</label>
            <textarea
              id={`${idBase}-allow`}
              value={userAllowRules}
              onChange={(e) => { setPermAllow(e.target.value); markDirty(); }}
              placeholder={"Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)"}
              className={`${settingsTextArea} h-16`}
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor={`${idBase}-deny`} className={settingsLabel}>Auto-deny tools, one per line</label>
            <textarea
              id={`${idBase}-deny`}
              value={userDenyRules}
              onChange={(e) => { setPermDeny(e.target.value); markDirty(); }}
              placeholder={"WebFetch\nBash(curl *)"}
              className={`${settingsTextArea} h-16`}
              spellCheck={false}
            />
          </div>
        </SettingsBlock>

        {/* Plugin permission rules: read-only with attribution */}
        {hasPluginPerms && (
          <SettingsBlock className="space-y-2">
            {pluginAllowRules.length > 0 && (
              <div>
                <div className={settingsLabel}>Plugin allow rules</div>
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
                <div className={settingsLabel}>Plugin deny rules</div>
                <ConfigItemList
                  items={pluginDenyRules}
                  orphanedPluginIds={orphanedPluginIds}
                  onRemove={setRemoveTarget}
                  removing={removing}
                />
              </div>
            )}
          </SettingsBlock>
        )}
      </SettingsSection>

      <SettingsSection title="Default .mcp.json">
        <SettingsBlock>
          <textarea
            aria-label="Default .mcp.json"
            value={userMcpJson}
            onChange={(e) => { setMcpJson(e.target.value); markDirty(); }}
            placeholder='{\n  "mcpServers": {}\n}'
            className={`${settingsTextArea} h-20`}
            spellCheck={false}
          />
        </SettingsBlock>

        {/* Plugin MCP servers: read-only with attribution */}
        {hasPluginMcp && (
          <SettingsBlock>
            <div className={settingsLabel}>Plugin MCP servers</div>
            <ConfigItemList
              items={pluginMcpServers}
              orphanedPluginIds={orphanedPluginIds}
              onRemove={setRemoveTarget}
              removing={removing}
            />
          </SettingsBlock>
        )}
      </SettingsSection>

      {/* Managed skills (provenance) above the source skill list */}
      {breakdown && breakdown.skills.length > 0 && (
        <SettingsSection title="Managed skills">
          <ConfigItemList
            items={breakdown.skills}
            orphanedPluginIds={orphanedPluginIds}
            onRemove={setRemoveTarget}
            removing={removing}
          />
        </SettingsSection>
      )}
      <SourceSkillsSection projectPath={projectPath} />

      {/* Managed agent definitions (provenance) above the source list */}
      {breakdown && breakdown.agentTemplates.length > 0 && (
        <SettingsSection title="Managed agent definitions">
          <ConfigItemList
            items={breakdown.agentTemplates}
            orphanedPluginIds={orphanedPluginIds}
            onRemove={setRemoveTarget}
            removing={removing}
          />
        </SettingsSection>
      )}
      <SourceAgentTemplatesSection projectPath={projectPath} />

      <ConfirmDialog
        open={showResetConfirm}
        title="Reset to defaults?"
        message="This replaces every project-level agent default (instructions, permissions and commands) with the built-in defaults. Plugin-injected configs stay. Your customizations will be lost."
        onConfirm={handleReset}
        onCancel={() => setShowResetConfirm(false)}
        confirming={resetting}
        confirmLabel="Reset"
        confirmingLabel="Resetting…"
        testId="reset-defaults-confirm"
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title="Remove plugin injection?"
        message={removeTarget
          ? `Remove "${removeTarget.label}", injected by the plugin "${removeTarget.provenance.source === 'plugin' ? removeTarget.provenance.pluginId : 'unknown'}"? The plugin may inject it again the next time it activates.`
          : ''}
        onConfirm={handleRemoveItem}
        onCancel={() => setRemoveTarget(null)}
        confirming={removing !== null}
        testId="remove-injection-confirm"
      />
    </div>
  );
}
