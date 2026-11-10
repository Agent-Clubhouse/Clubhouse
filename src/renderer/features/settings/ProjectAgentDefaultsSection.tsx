import { useEffect, useId, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';

import type { SourceControlProvider, ProjectAgentDefaults, ProjectAgentDefaultsPatch, ProjectConfigBreakdown, ProvenancedConfigItem } from '../../../shared/types';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { usePluginStore } from '../../plugins/plugin-store';
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

function Code({ children }: { children: ReactNode }) {
  return <code className={CODE_CLASS}>{children}</code>;
}

interface Props {
  projectPath: string;
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

// ── Editor values ────────────────────────────────────────────────────────

/** What the page edits: the user's part only, never plugin-attributed values (#3244). */
interface EditorValues {
  instructions: string;
  permAllow: string;
  permDeny: string;
  mcpJson: string;
  helperAutoOff: boolean;
  /** Empty: the project uses the app setting. */
  sourceControlProvider: SourceControlProvider | '';
  buildCommand: string;
  testCommand: string;
  lintCommand: string;
  commandPrefix: string;
}

const EMPTY_VALUES: EditorValues = {
  instructions: '', permAllow: '', permDeny: '', mcpJson: '', helperAutoOff: false,
  sourceControlProvider: '', buildCommand: '', testCommand: '', lintCommand: '', commandPrefix: '',
};

function userRules(rules: ProvenancedConfigItem[]): string {
  return rules.filter((r) => r.provenance.source === 'user').map((r) => r.value).join('\n');
}

/** The saved .mcp.json without the servers plugins put there. */
function userMcpJson(mcpJson: string, breakdown: ProjectConfigBreakdown | null): string {
  if (!breakdown || !mcpJson) return mcpJson;
  const pluginNames = new Set(breakdown.mcpServers.filter((s) => s.provenance.source === 'plugin').map((s) => s.label));
  if (pluginNames.size === 0) return mcpJson;
  try {
    const parsed = JSON.parse(mcpJson);
    const servers: Record<string, unknown> = parsed.mcpServers || {};
    const userServers = Object.fromEntries(Object.entries(servers).filter(([name]) => !pluginNames.has(name)));
    const { mcpServers: _servers, ...rest } = parsed;
    if (Object.keys(userServers).length === 0 && Object.keys(rest).length === 0) return '';
    return JSON.stringify({ ...rest, mcpServers: userServers }, null, 2);
  } catch {
    return mcpJson;
  }
}

function editorValuesFrom(d: ProjectAgentDefaults, breakdown: ProjectConfigBreakdown | null): EditorValues {
  return {
    instructions: breakdown ? breakdown.userInstructions : d.instructions || '',
    permAllow: breakdown ? userRules(breakdown.allowRules) : (d.permissions?.allow || []).join('\n'),
    permDeny: breakdown ? userRules(breakdown.denyRules) : (d.permissions?.deny || []).join('\n'),
    mcpJson: userMcpJson(d.mcpJson || '', breakdown),
    helperAutoOff: d.helperAuto === 'off',
    sourceControlProvider: d.sourceControlProvider ?? '',
    buildCommand: d.buildCommand || '',
    testCommand: d.testCommand || '',
    lintCommand: d.lintCommand || '',
    commandPrefix: d.commandPrefix || '',
  };
}

function lines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * Only the fields that changed since load, so a save can't undo anyone else's newer change (#3244).
 * A saved persona or mission (#2901) isn't offered, so it's never in the patch and stays for the switch to managed.
 */
function patchFrom(values: EditorValues, baseline: EditorValues, hadFreeAgentMode: boolean): ProjectAgentDefaultsPatch {
  const patch: ProjectAgentDefaultsPatch = {};
  const changed = (key: keyof EditorValues) => values[key] !== baseline[key];
  const text = (v: string) => v.trim() || null;
  if (changed('instructions')) patch.instructions = text(values.instructions) && values.instructions;
  if (changed('permAllow') || changed('permDeny')) {
    const allow = lines(values.permAllow);
    const deny = lines(values.permDeny);
    patch.permissions = allow.length || deny.length ? { allow, deny } : null;
  }
  if (changed('mcpJson')) patch.mcpJson = text(values.mcpJson) && values.mcpJson;
  if (changed('helperAutoOff')) patch.helperAuto = values.helperAutoOff ? 'off' : null;
  if (changed('sourceControlProvider')) patch.sourceControlProvider = values.sourceControlProvider || null;
  if (changed('buildCommand')) patch.buildCommand = text(values.buildCommand);
  if (changed('testCommand')) patch.testCommand = text(values.testCommand);
  if (changed('lintCommand')) patch.lintCommand = text(values.lintCommand);
  if (changed('commandPrefix')) patch.commandPrefix = text(values.commandPrefix);
  // The project's "Free agent mode by default" is retired (#2761): new agents start at the app's Default access.
  if (hadFreeAgentMode) patch.freeAgentMode = null;
  return patch;
}

// ── Main component ───────────────────────────────────────────────────────

/** Keyed by project, so nothing typed or loaded for one project can reach another's save (#3244). */
export function ProjectAgentDefaultsSection({ projectPath }: Props) {
  return <ProjectAgentDefaultsEditor key={projectPath} projectPath={projectPath} />;
}

function ProjectAgentDefaultsEditor({ projectPath }: Props) {
  const [values, setValues] = useState<EditorValues>(EMPTY_VALUES);
  const [baseline, setBaseline] = useState<EditorValues>(EMPTY_VALUES);
  const [hadFreeAgentMode, setHadFreeAgentMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadSeq = useRef(0);
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
  const pluginIdsRef = useRef(pluginIds);
  pluginIdsRef.current = pluginIds;

  /** Reads the saved defaults into the editor, replacing what's there. */
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const d = await window.clubhouse.agentSettings.readProjectAgentDefaults(projectPath);
      let bd: ProjectConfigBreakdown | null = null;
      try {
        bd = await window.clubhouse.agentSettings.getProjectConfigBreakdown(projectPath, pluginIdsRef.current);
      } catch {
        // Without a breakdown the editor shows the raw values; the save still keeps plugin parts.
      }
      if (seq !== loadSeq.current) return;
      const next = editorValuesFrom(d, bd);
      setBreakdown(bd);
      setValues(next);
      setBaseline(next);
      setHadFreeAgentMode(d.freeAgentMode !== undefined);
      setLoadError(null);
      setLoaded(true);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(ipcErrorMessage(err));
    }
  }, [projectPath]);

  /** Refreshes only the plugin attribution, leaving unsaved edits alone. */
  const refreshBreakdown = useCallback(async () => {
    try {
      setBreakdown(await window.clubhouse.agentSettings.getProjectConfigBreakdown(projectPath, pluginIdsRef.current));
    } catch {
      // Fallback — breakdown not available
    }
  }, [projectPath]);

  useEffect(() => {
    load();
  }, [load]);

  const pluginIdsSeen = useRef(pluginIdsSerialized);
  useEffect(() => {
    if (pluginIdsSeen.current === pluginIdsSerialized) return;
    pluginIdsSeen.current = pluginIdsSerialized;
    if (loaded) refreshBreakdown();
  }, [loaded, pluginIdsSerialized, refreshBreakdown]);

  const dirty = (Object.keys(values) as (keyof EditorValues)[]).some((k) => values[k] !== baseline[k]);

  const handleSave = async () => {
    const saved = values;
    setSaving(true);
    setSaveError(null);
    try {
      await window.clubhouse.agentSettings.saveProjectUserDefaults(projectPath, patchFrom(saved, baseline, hadFreeAgentMode));
    } catch (err) {
      setSaveError(ipcErrorMessage(err));
      setSaving(false);
      return;
    }
    setBaseline(saved);
    setHadFreeAgentMode(false);
    setSaving(false);
    await load();
  };

  const handleRemoveItem = async () => {
    if (!removeTarget) return;
    setRemoving(removeTarget.id);
    try {
      await window.clubhouse.agentSettings.removePluginInjectionItem(projectPath, removeTarget.id);
      await refreshBreakdown();
    } catch { /* ignore */ }
    setRemoving(null);
    setRemoveTarget(null);
  };

  if (loadError && !loaded) {
    return (
      <div data-testid="project-agent-defaults-section">
        <SettingsSection title="Default agent settings">
          <p role="alert" className="text-xs text-ctp-error mb-2">Couldn&apos;t load this project&apos;s default agent settings. {loadError}</p>
          <Button onClick={load} kind="ghost">Try again</Button>
        </SettingsSection>
      </div>
    );
  }

  if (!loaded) return null;

  const orphanedPluginIds = breakdown?.orphanedPluginIds || [];
  const pluginAllowRules = breakdown?.allowRules.filter((r) => r.provenance.source === 'plugin') || [];
  const pluginDenyRules = breakdown?.denyRules.filter((r) => r.provenance.source === 'plugin') || [];
  const pluginMcpServers = breakdown?.mcpServers.filter((s) => s.provenance.source === 'plugin') || [];
  const hasPluginPerms = pluginAllowRules.length > 0 || pluginDenyRules.length > 0;
  const hasPluginMcp = pluginMcpServers.length > 0;

  const setValue = <K extends keyof EditorValues>(key: K, value: EditorValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div data-testid="project-agent-defaults-section">
      <SettingsSection
        title="Default agent settings"
        actions={
          <>
            <Button onClick={handleSave} disabled={!dirty || saving} kind="primary">
              {saving ? 'Saving…' : 'Save defaults'}
            </Button>
          </>
        }
      >
        <p className={`${settingsHelp} mb-2`}>
          These settings are applied as snapshots when new durable agents are created. Changes here do not affect existing agents.
        </p>
        {saveError && (
          <p role="alert" className="text-xs text-ctp-error mb-2">Couldn&apos;t save defaults. {saveError}</p>
        )}
        {loadError && (
          <p role="alert" className="text-xs text-ctp-error mb-2">Couldn&apos;t reload this project&apos;s default agent settings. {loadError}</p>
        )}

        {orphanedPluginIds.length > 0 && (
          <OrphanBanner
            orphanedPluginIds={orphanedPluginIds}
            projectPath={projectPath}
            onCleaned={refreshBreakdown}
          />
        )}

        <SettingsField
          label="Source control provider"
          help={<>Fills <Code>@@SourceControlProvider</Code> for agents that aren't Clubhouse-managed. Managed agents work out the host from the repository.</>}
          htmlFor={`${idBase}-scp`}
        >
          <select
            id={`${idBase}-scp`}
            value={values.sourceControlProvider}
            onChange={(e) => setValue('sourceControlProvider', e.target.value as SourceControlProvider | '')}
            className={SELECT_CLASS}
          >
            <option value="">Use app setting</option>
            <option value="github">GitHub (gh CLI)</option>
            <option value="azure-devops">Azure DevOps (az CLI)</option>
          </select>
        </SettingsField>

        <SettingsField
          label="Command prefix"
          help={<>Shell command run before the agent CLI, like <Code>. ./init.ps1</Code>. It runs in the same shell, so exported variables and PATH changes reach the agent.</>}
          htmlFor={`${idBase}-prefix`}
        >
          <input
            id={`${idBase}-prefix`}
            value={values.commandPrefix}
            onChange={(e) => setValue('commandPrefix', e.target.value)}
            placeholder=". ./init.sh"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>

        <SettingsField
          label="Turn off Auto provider here"
          help="Orchestrators here can’t let Clubhouse pick a helper’s provider. A project can turn this off, but not on."
        >
          <Toggle
            aria-label="Turn off Auto provider in this project"
            checked={values.helperAutoOff}
            onChange={(v) => setValue('helperAutoOff', v)}
            data-testid="project-helper-auto-off"
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Project commands">
        <p className={`${settingsHelp} mb-2`}>
          Commands that fill <Code>@@BuildCommand</Code>, <Code>@@TestCommand</Code> and{' '}
          <Code>@@LintCommand</Code> for agents that aren't Clubhouse-managed. Managed agents use their build, test, lint and validate skills.
        </p>
        <SettingsField label="Build" htmlFor={`${idBase}-build`}>
          <input
            id={`${idBase}-build`}
            value={values.buildCommand}
            onChange={(e) => setValue('buildCommand', e.target.value)}
            placeholder="npm run build"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>
        <SettingsField label="Test" htmlFor={`${idBase}-test`}>
          <input
            id={`${idBase}-test`}
            value={values.testCommand}
            onChange={(e) => setValue('testCommand', e.target.value)}
            placeholder="npm test"
            className={TEXT_INPUT_CLASS}
            spellCheck={false}
          />
        </SettingsField>
        <SettingsField label="Lint" htmlFor={`${idBase}-lint`}>
          <input
            id={`${idBase}-lint`}
            value={values.lintCommand}
            onChange={(e) => setValue('lintCommand', e.target.value)}
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
            value={values.instructions}
            onChange={(e) => setValue('instructions', e.target.value)}
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
              value={values.permAllow}
              onChange={(e) => setValue('permAllow', e.target.value)}
              placeholder={"Bash(git checkout:*)\nBash(git pull:*)\nBash(npm run:*)"}
              className={`${settingsTextArea} h-16`}
              spellCheck={false}
            />
          </div>
          <div>
            <label htmlFor={`${idBase}-deny`} className={settingsLabel}>Auto-deny tools, one per line</label>
            <textarea
              id={`${idBase}-deny`}
              value={values.permDeny}
              onChange={(e) => setValue('permDeny', e.target.value)}
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
            value={values.mcpJson}
            onChange={(e) => setValue('mcpJson', e.target.value)}
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
