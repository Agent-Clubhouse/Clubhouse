import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import type { ProjectConfigBreakdown, ProvenancedConfigItem } from '../../../shared/types';
import type { LegacyCopyPreview, LegacyDefaultsSummary, LegacyImportPreview, LegacyImportResult } from '../../../shared/legacy-defaults-types';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { CopyChangeList } from '../agents/LegacyDefaultsCopy';
import { SettingsSection, SettingsBlock, settingsLabel, settingsHelp, settingsInput } from './SettingsLayout';

const PRE_CLASS = 'text-[11px] text-ctp-subtext0 font-mono whitespace-pre-wrap overflow-x-auto max-h-40 overflow-y-auto';

/** A plugin's item: who put it there, and a way to take it out. */
export interface PluginItemControls {
  breakdown: ProjectConfigBreakdown | null;
  orphanedPluginIds: string[];
  /** One plugin item's row: its plugin, and its remove button. */
  renderItem: (item: ProvenancedConfigItem, isOrphan: boolean) => ReactNode;
}

function Lines({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className={settingsHelp}>{empty}</p>;
  return (
    <ul className="text-xs font-mono text-ctp-text space-y-0.5">
      {items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function joinNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The project's legacy agent defaults (#3245): shown read-only, with where
 * they still apply, and actions to import them as parts or copy them into a
 * plain agent. Each action is previewed and runs only when confirmed. Nothing
 * here edits or removes a saved value, except a plugin's own items.
 */
export function LegacyDefaultsSection({ projectPath, plugins, reloadKey }: { projectPath: string; plugins: PluginItemControls; reloadKey: number }) {
  const [summary, setSummary] = useState<LegacyDefaultsSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'import' | 'copy' | null>(null);

  const load = useCallback(async () => {
    try {
      setSummary(await window.clubhouse.legacyDefaults.describe(projectPath));
      setLoadError(null);
    } catch (err) {
      // telemetry-exempt: shown to the person in place
      setLoadError(ipcErrorMessage(err));
    }
  }, [projectPath]);

  useEffect(() => { void load(); }, [load, reloadKey]);

  if (loadError && !summary) {
    return (
      <SettingsSection title="Legacy defaults">
        <p role="alert" className="text-xs text-ctp-error mb-2">Couldn&apos;t load this project&apos;s legacy defaults. {loadError}</p>
        <Button onClick={load} kind="ghost">Try again</Button>
      </SettingsSection>
    );
  }
  if (!summary) return null;

  const bd = plugins.breakdown;
  const pluginBlocks = bd?.pluginInstructionBlocks ?? [];
  const pluginRules = [...(bd?.allowRules ?? []), ...(bd?.denyRules ?? [])].filter((r) => r.provenance.source === 'plugin');
  const pluginServers = (bd?.mcpServers ?? []).filter((s) => s.provenance.source === 'plugin');
  const hasPluginItems = pluginBlocks.length > 0 || pluginRules.length > 0 || pluginServers.length > 0;
  if (!summary.hasValues && !hasPluginItems) return null;

  const isOrphan = (item: ProvenancedConfigItem) => item.provenance.source === 'plugin' && plugins.orphanedPluginIds.includes(item.provenance.pluginId);
  const userAllow = summary.permissions.allow.filter((r) => !/\/\* plugin:/.test(r));
  const userDeny = summary.permissions.deny.filter((r) => !/\/\* plugin:/.test(r));
  const { buildCommand, testCommand, lintCommand } = summary.commands;
  const hasCommands = !!(buildCommand || testCommand || lintCommand);

  return (
    <div data-testid="legacy-defaults-section">
      <SettingsSection
        title="Legacy defaults"
        actions={
          <>
            <Button onClick={() => setDialog('import')} kind="ghost" data-testid="legacy-import-open">Import as parts…</Button>
            <Button onClick={() => setDialog('copy')} kind="ghost" disabled={summary.plainAgents.length === 0} data-testid="legacy-copy-open">Copy to a plain agent…</Button>
          </>
        }
      >
        <p className={`${settingsHelp} mb-2`}>
          Agent defaults saved before Clubhouse-managed agents. They&apos;re read-only and kept as they are, so nothing is lost.
          New agents get them only when you choose to copy them in, and managed agents never do.
          Import them as parts to use them in managed agents, or copy them into a plain agent.
        </p>

        <SettingsBlock>
          <div className={settingsLabel}>Instructions</div>
          {summary.instructions ? <pre className={PRE_CLASS}>{summary.instructions}</pre> : <p className={settingsHelp}>None.</p>}
          {pluginBlocks.map((block) => (
            <div key={block.id} className="border-t border-surface-0 mt-2">
              {plugins.renderItem(block, isOrphan(block))}
              <pre className={`pb-2 ${PRE_CLASS}`}>{block.value}</pre>
            </div>
          ))}
        </SettingsBlock>

        <SettingsBlock className="space-y-2">
          <div>
            <div className={settingsLabel}>Allowed tools</div>
            <Lines items={userAllow} empty="None." />
          </div>
          <div>
            <div className={settingsLabel}>Denied tools</div>
            <Lines items={userDeny} empty="None." />
          </div>
          {pluginRules.map((rule) => <div key={rule.id}>{plugins.renderItem(rule, isOrphan(rule))}</div>)}
          <p className={settingsHelp}>Copied only into plain agents on a CLI with allow and deny rules.</p>
        </SettingsBlock>

        <SettingsBlock>
          <div className={settingsLabel}>MCP servers</div>
          {summary.mcpJson.trim() ? <pre className={PRE_CLASS}>{summary.mcpJson}</pre> : <p className={settingsHelp}>None.</p>}
          {!summary.mcpJsonValid && <p className="text-xs text-ctp-error">This isn&apos;t valid JSON, so no agent gets these servers.</p>}
          {pluginServers.map((server) => <div key={server.id}>{plugins.renderItem(server, isOrphan(server))}</div>)}
          {summary.inheritingMcp.length > 0 && (
            <p className={`${settingsHelp} mt-1`} data-testid="legacy-mcp-reach">
              Still given at start to {joinNames(summary.inheritingMcp.map((a) => a.name))}, plain {summary.inheritingMcp.length === 1 ? 'agent' : 'agents'} without an MCP file of {summary.inheritingMcp.length === 1 ? 'its' : 'their'} own.
              Copying them in gives {summary.inheritingMcp.length === 1 ? 'it' : 'each'} its own file instead.
            </p>
          )}
        </SettingsBlock>

        <SettingsBlock>
          <div className={settingsLabel}>Commands</div>
          {hasCommands ? (
            <ul className="text-xs text-ctp-text space-y-0.5">
              {buildCommand && <li>Build: <span className="font-mono">{buildCommand}</span></li>}
              {testCommand && <li>Test: <span className="font-mono">{testCommand}</span></li>}
              {lintCommand && <li>Lint: <span className="font-mono">{lintCommand}</span></li>}
            </ul>
          ) : <p className={settingsHelp}>None.</p>}
          {hasCommands && <p className={`${settingsHelp} mt-1`}>They still fill @@BuildCommand, @@TestCommand and @@LintCommand in the MCP servers above for plain agents that have no commands of their own.</p>}
        </SettingsBlock>
      </SettingsSection>

      {dialog === 'import' && <ImportDialog projectPath={projectPath} onClose={() => setDialog(null)} />}
      {dialog === 'copy' && <CopyDialog projectPath={projectPath} agents={summary.plainAgents} onClose={() => setDialog(null)} onCopied={load} />}
    </div>
  );
}

function ImportDialog({ projectPath, onClose }: { projectPath: string; onClose: () => void }) {
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [result, setResult] = useState<LegacyImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.clubhouse.legacyDefaults.previewImport(projectPath)
      .then((p) => { if (live) setPreview(p); })
      .catch((err) => { if (live) setError(ipcErrorMessage(err)); });
    return () => { live = false; };
  }, [projectPath]);

  const newParts = preview?.parts.filter((p) => p.status === 'new') ?? [];
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await window.clubhouse.legacyDefaults.importAsParts(projectPath));
    } catch (err) {
      // telemetry-exempt: shown to the person in place
      setError(ipcErrorMessage(err));
    }
    setBusy(false);
  };

  const kindName = (kind: 'block' | 'mcp') => (kind === 'block' ? 'Instruction block' : 'MCP server');

  return (
    <Modal open onClose={onClose} title="Import legacy defaults as parts" width="w-[480px] max-w-[calc(100vw-32px)]" footer={
      result
        ? <Button onClick={onClose} kind="primary">Done</Button>
        : (
          <>
            <Button onClick={onClose} kind="ghost">Cancel</Button>
            <Button onClick={run} kind="primary" disabled={busy || !preview || newParts.length === 0} data-testid="legacy-import-confirm">
              {busy ? 'Importing…' : 'Import'}
            </Button>
          </>
        )
    }>
      <div className="space-y-2 text-xs text-ctp-subtext0" data-testid="legacy-import-dialog">
        {error && <p role="alert" className="text-ctp-error">{error}</p>}
        {!preview && !error && <p>Working out what would be imported…</p>}
        {preview && !result && (
          <>
            <p>These become parts in your library, for any managed agent or template. The saved defaults stay as they are.</p>
            {preview.parts.length === 0
              ? <p>Nothing here can become a part.</p>
              : (
                <ul className="space-y-0.5">
                  {preview.parts.map((p) => (
                    <li key={`${p.kind}:${p.name}`}>
                      {kindName(p.kind)} <span className="font-mono text-ctp-subtext1">{p.name}</span>
                      {p.pluginId && <>, kept up to date by the {p.pluginId} plugin</>}
                      {p.status === 'in_library' ? (p.pluginId ? ': the plugin already has it, not made again' : ': already in your library, not made again') : ''}
                    </li>
                  ))}
                </ul>
              )}
            {preview.notes.length > 0 && (
              <ul className="space-y-0.5">
                {preview.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
          </>
        )}
        {result && (
          <>
            {result.created.length > 0
              ? <p>Imported {joinNames(result.created.map((p) => p.name))}. Add them to an agent or template from its setup.</p>
              : !result.pluginParts?.length && <p>Nothing new was imported.</p>}
            {result.existing.length > 0 && <p>Already in your library: {joinNames(result.existing.map((p) => p.name))}.</p>}
            {result.pluginParts && result.pluginParts.length > 0 && <p>Made for their plugins: {joinNames(result.pluginParts)}. Each plugin keeps its parts up to date.</p>}
            {result.notes.length > 0 && (
              <ul className="space-y-0.5">
                {result.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function CopyDialog({ projectPath, agents, onClose, onCopied }: {
  projectPath: string;
  agents: LegacyDefaultsSummary['plainAgents'];
  onClose: () => void;
  onCopied: () => void;
}) {
  const selectId = useId();
  const [agentId, setAgentId] = useState(agents[0]?.id ?? '');
  const [preview, setPreview] = useState<LegacyCopyPreview | null>(null);
  const [done, setDone] = useState<LegacyCopyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let live = true;
    setPreview(null);
    setError(null);
    window.clubhouse.legacyDefaults.previewCopy(projectPath, agentId)
      .then((p) => { if (live) setPreview(p); })
      .catch((err) => { if (live) setError(ipcErrorMessage(err)); });
    return () => { live = false; };
  }, [projectPath, agentId]);

  const writes = preview?.changes.some((c) => c.action !== 'unchanged' && c.action !== 'skip') ?? false;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setDone(await window.clubhouse.legacyDefaults.copyIntoAgent(projectPath, agentId));
      onCopied();
    } catch (err) {
      // telemetry-exempt: shown to the person in place
      setError(ipcErrorMessage(err));
    }
    setBusy(false);
  };

  return (
    <Modal open onClose={onClose} title="Copy legacy defaults to a plain agent" width="w-[520px] max-w-[calc(100vw-32px)]" footer={
      done
        ? <Button onClick={onClose} kind="primary">Done</Button>
        : (
          <>
            <Button onClick={onClose} kind="ghost">Cancel</Button>
            <Button onClick={run} kind="primary" disabled={busy || !preview || !!preview.blocked || !writes} data-testid="legacy-copy-confirm">
              {busy ? 'Copying…' : 'Copy'}
            </Button>
          </>
        )
    }>
      <div className="space-y-2 text-xs text-ctp-subtext0" data-testid="legacy-copy-dialog">
        {!done && (
          <div className="flex items-center gap-2">
            <label htmlFor={selectId} className="text-ctp-text">Agent</label>
            <select id={selectId} value={agentId} onChange={(e) => setAgentId(e.target.value)} className={`${settingsInput} w-[260px]`}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name}{a.cli ? ` (${a.cli})` : ''}</option>)}
            </select>
          </div>
        )}
        {error && <p role="alert" className="text-ctp-error">{error}</p>}
        {!done && preview && (
          <>
            <p>What changes in {preview.agentName}&apos;s folder and settings. Nothing is written until you copy.</p>
            <CopyChangeList preview={preview} />
            {!preview.blocked && !writes && <p>It already has everything that can be copied.</p>}
            <p>It takes effect at its next start.</p>
          </>
        )}
        {done && (
          <>
            <p>Copied into {done.agentName}. It takes effect at its next start.</p>
            <CopyChangeList preview={done} />
          </>
        )}
      </div>
    </Modal>
  );
}
