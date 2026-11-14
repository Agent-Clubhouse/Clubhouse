import { useId, useState } from 'react';
import { TabList, tabPanelProps } from '../../components/TabList';
import { isListed, type ManagedTemplate, type ManagedTemplateChange, type ManagedTemplatePushTarget } from '../../../shared/managed-agents-types';
import { DEFAULT_MAX_HELPERS, MAX_HELPER_LIMIT, ORCHESTRATION_DEFAULTS } from '../../../shared/orchestration-policy';
import { normalizeIdleSleep } from '../../../shared/idle-sleep';
import { ACCESS_DESCRIPTIONS, ACCESS_LEVELS, accessLabel, accessLevelsFor, isAccessLevel, type AccessLevel } from '../../../shared/agent-access';
import type { OrchestratorId } from '../../../shared/types';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { PopupMenu } from '../../components/PopupMenu';
import { Toggle } from '../../components/Toggle';
import { SettingsField, SettingsPage, SettingsSection, settingsError, settingsHelp, settingsInput } from '../settings/SettingsLayout';
import { ManagedBuilder, type SetupDraft } from './ManagedBuilder';
import { TemplatePushDialog } from './TemplatePushDialog';
import { ProjectTemplatesSection } from './ProjectTemplates';
import { TemplateGrantsSection } from './TemplateGrantsSection';
import { settingsAccess } from './create-managed-agent';
import { errorText, managed, unwrap, useManagedTemplates } from './managedApi';
import { changedLine } from './attribution';
import {
  EffortSelect, HELPER_SELECTION_HELP, HELPER_TEMPLATE_HELP, HelperSelectionSelect, HelperTemplateSelect, IDLE_SLEEP_HELP, IdleSleepSelect,
  effortHelp, useModelEfforts,
} from './settings-fields';
import { AccessSelect, ControlSelect, DISPATCHER_HELP } from '../agents/helpers/OrchestrationFields';
import { useModelOptions } from '../../hooks/useModelOptions';
import { useOrchestratorStore } from '../../stores/orchestratorStore';

const selectClass = `${settingsInput} cursor-pointer`;

type ListedTemplate = ManagedTemplate & { usedBy: number };
type TemplateDraft = Pick<ManagedTemplate, 'name' | 'description' | 'setup' | 'settings'> & { id?: string };
type EditorTab = 'instructions' | 'skills' | 'mcp';

const TABS: Array<{ id: EditorTab; label: string }> = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'skills', label: 'Skills' },
  { id: 'mcp', label: 'MCP servers' },
];

const BLANK: TemplateDraft = { name: '', description: '', setup: { blocks: [], skills: [], mcps: [] }, settings: {} };

/** "Orchestrator copy", then "Orchestrator copy 2", so a second copy doesn't clash. */
export function copyName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  const base = `${name} copy`;
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!lower.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** The person's copy of a built-in template an app update retired (D99). */
const RETIRED_TEMPLATE_NOTE = 'Your copy of a built-in template Clubhouse no longer ships. Edit it like any of your templates.';

const usage = (n: number) => (n === 0 ? 'No agents' : `${n} agent${n === 1 ? '' : 's'}`);

function TemplateRow({ t, children }: { t: ListedTemplate; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,90px)_auto] gap-x-4 items-center py-2 border-t border-surface-0" data-testid="managed-template-row">
      <span className="min-w-0">
        <span className="block text-[13px] text-ctp-text truncate">{t.name}</span>
        {t.description && <span className="block text-xs text-ctp-overlay1 truncate">{t.description}</span>}
        {t.updatedBy && <span className="block text-xs text-ctp-overlay1 truncate" data-testid="managed-template-changed">{changedLine(t.updatedAt, t.updatedBy)}</span>}
        {t.fromRetiredBuiltin && <span className="block text-xs text-ctp-overlay1 truncate" data-testid="managed-template-retired-copy">{RETIRED_TEMPLATE_NOTE}</span>}
        {t.source && <span className="block text-xs text-ctp-overlay1 truncate" data-testid="managed-template-project">Project · {t.projectName ?? 'a removed project'}</span>}
      </span>
      <span className="text-xs text-ctp-overlay1 truncate">{usage(t.usedBy)}</span>
      <span className="flex items-center gap-1">{children}</span>
    </li>
  );
}

const MoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
);

/** The template editor: name, the builder in draft mode, and orchestration settings. */
function TemplateEditor({ initial, onDone }: { initial: TemplateDraft; onDone: (notice?: string) => void }) {
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [tab, setTab] = useState<EditorTab>('instructions');
  const tabsId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<{ changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] } | null>(null);
  const orch = draft.settings.orchestration ?? {};
  const orchestrate = orch.orchestrate === true;
  const [maxDraft, setMaxDraft] = useState(String(orch.maxHelpers ?? DEFAULT_MAX_HELPERS));

  const setSetup = (setup: SetupDraft) => setDraft((d) => ({ ...d, setup: { blocks: setup.blocks, skills: setup.skills, mcps: setup.mcps } }));
  const setOrch = (patch: Partial<NonNullable<TemplateDraft['settings']['orchestration']>>) =>
    setDraft((d) => {
      const next = { ...(d.settings.orchestration ?? {}), ...patch };
      // Unset means the agent follows the app or the default, so the key goes.
      for (const k of Object.keys(next) as Array<keyof typeof next>) if (next[k] === undefined) delete next[k];
      return { ...d, settings: { ...d.settings, orchestration: next } };
    });
  /** A template sets only what it names: an unset value takes the key out. */
  const setSetting = (patch: Partial<TemplateDraft['settings']>) =>
    setDraft((d) => {
      const next = { ...d.settings, ...patch } as Record<string, unknown>;
      for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
      return { ...d, settings: next as TemplateDraft['settings'] };
    });
  const settings = draft.settings;
  const allOrchestrators = useOrchestratorStore((st) => st.allOrchestrators);
  const cli = settings.orchestrator ?? '';
  const { options: modelOptions, loading: modelsLoading } = useModelOptions(cli || undefined);
  const modelValue = settings.model ?? 'default';
  const modelChoices = modelOptions.some((o) => o.id === modelValue) ? modelOptions : [...modelOptions, { id: modelValue, label: modelValue }];
  const { levelsFor, loading: effortsLoading } = useModelEfforts(cli || undefined);
  const effortLevels = cli ? levelsFor(modelValue) : [];
  const effortValue = settings.effort ?? '';
  // Access (#2761). Unset: an agent made from it starts at the Default access.
  // A template saved before #2761 may carry only the legacy flag.
  const accessValue = settingsAccess(settings);
  const cliInfo = cli ? allOrchestrators.find((o) => o.id === cli) : undefined;
  const accessUnsupported = !!cliInfo && !cliInfo.capabilities?.permissions;
  // No CLI set: it may run on any, so every level is offered.
  const accessLevels = cli ? accessLevelsFor(cli) : ACCESS_LEVELS;
  const accessChoices = accessValue && !accessLevels.includes(accessValue) ? [...accessLevels, accessValue] : accessLevels;
  // Setting the level drops the legacy flag; main writes it again from the level.
  const setAccess = (level: AccessLevel | undefined) => setSetting({ access: level, freeAgentMode: undefined });
  const commitMax = () => {
    const n = Number(maxDraft);
    if (!Number.isInteger(n) || n < 1 || n > MAX_HELPER_LIMIT) { setMaxDraft(String(orch.maxHelpers ?? DEFAULT_MAX_HELPERS)); return; }
    setOrch({ maxHelpers: n });
  };

  const input = () => ({ name: draft.name, description: draft.description, setup: draft.setup, settings: draft.settings });
  const next = () => ({ setup: draft.setup, settings: draft.settings });

  const saveOnly = async () => {
    setBusy(true);
    setError(null);
    try {
      await unwrap(managed().saveTemplate({ ...input(), ...(draft.id && { id: draft.id }) }));
      onDone();
    } catch (err) {
      // telemetry-exempt: shown in the editor or the dialog.
      setError(errorText(err));
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft.id) { await saveOnly(); return; }
    setBusy(true);
    setError(null);
    try {
      const preview = await unwrap(managed().previewTemplatePush(draft.id, next()));
      if (preview.changes.length === 0 || preview.targets.length === 0) { await saveOnly(); return; }
      setPush(preview);
      setBusy(false);
    } catch (err) {
      // telemetry-exempt: shown in the editor.
      setError(errorText(err));
      setBusy(false);
    }
  };

  const saveAndApply = async (targets: ManagedTemplatePushTarget[]) => {
    if (!draft.id) return;
    setBusy(true);
    setError(null);
    try {
      // The push compares with the saved template, so it runs before the save.
      const { failed } = await unwrap(managed().pushTemplate(draft.id, next(), targets.map((t) => ({ projectPath: t.projectPath, agentId: t.agentId }))));
      await unwrap(managed().saveTemplate({ ...input(), id: draft.id }));
      if (failed.length === 0) { onDone(`Saved ${draft.name} and applied it to ${targets.length} agent${targets.length === 1 ? '' : 's'}.`); return; }
      const nameOf = (id: string) => targets.find((t) => t.agentId === id)?.agentName ?? id;
      onDone(`Saved ${draft.name}. Couldn't apply it to ${failed.map((f) => `${nameOf(f.agentId)} (${f.message})`).join(', ')}.`);
    } catch (err) {
      // telemetry-exempt: shown in the dialog.
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      title={initial.id ? `Edit ${initial.name}` : 'New template'}
      description="Agents made from a template aren't linked to it. Saving can apply your changes to the ones you pick."
      actions={<>
        <Button onClick={() => onDone()} disabled={busy}>Cancel</Button>
        <Button kind="primary" onClick={() => void save()} disabled={busy || !draft.name.trim()} data-testid="managed-template-save">Save</Button>
      </>}
      testId="managed-template-editor"
    >
      {error && !push && <p role="alert" className={`${settingsError} mt-2`}>{error}</p>}
      <SettingsSection title="Template">
        <SettingsField label="Name" htmlFor="managed-template-name">
          <input id="managed-template-name" className={`${settingsInput} w-[260px]`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
        </SettingsField>
        <SettingsField label="Description" htmlFor="managed-template-description" help="Shown when someone picks a template for a new agent.">
          <input id="managed-template-description" className={`${settingsInput} w-[260px]`} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title="Parts">
        <TabList<EditorTab>
          label="Template parts"
          idPrefix={tabsId}
          value={tab}
          options={TABS}
          onChange={setTab}
          className="flex items-center gap-0.5 mb-2 border-b border-surface-0"
          tabClassName={(selected) => `h-8 px-2.5 -mb-px border-b-2 text-xs cursor-pointer focus-ring ${selected ? 'border-ctp-text text-ctp-text' : 'border-transparent text-ctp-subtext0 hover:text-ctp-text'}`}
        />
        <div {...tabPanelProps(tabsId, tab)}>
          <ManagedBuilder target={{ kind: 'draft', value: draft.setup, onChange: setSetup, agentName: draft.name || 'the agent' }} tab={tab} />
        </div>
      </SettingsSection>

      <SettingsSection title="Settings">
        <SettingsField label="CLI" htmlFor="managed-template-cli" help="Not set: an agent made from it runs on its project's CLI.">
          <select
            id="managed-template-cli"
            className={selectClass}
            value={cli}
            onChange={(e) => setSetting({ orchestrator: (e.target.value || undefined) as OrchestratorId | undefined, model: undefined, effort: undefined })}
          >
            <option value="">Not set</option>
            {cli && !allOrchestrators.some((o) => o.id === cli) && <option value={cli}>{cli}</option>}
            {allOrchestrators.map((o) => <option key={o.id} value={o.id}>{o.displayName}</option>)}
          </select>
        </SettingsField>
        <SettingsField label="Model" htmlFor="managed-template-model" help={cli ? undefined : 'Pick a CLI to set a model.'} disabled={!cli}>
          <select
            id="managed-template-model"
            className={selectClass}
            value={modelValue}
            disabled={!cli || modelsLoading}
            onChange={(e) => setSetting({ model: e.target.value === 'default' ? undefined : e.target.value, effort: undefined })}
          >
            {modelChoices.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </SettingsField>
        <SettingsField label="Effort" htmlFor="managed-template-effort" help={cli ? effortHelp(effortLevels, effortsLoading) : 'Pick a CLI to set an effort.'} disabled={!cli}>
          <EffortSelect
            id="managed-template-effort"
            value={effortValue}
            levels={effortLevels}
            disabled={!cli || effortsLoading || (effortLevels.length === 0 && !effortValue)}
            className={selectClass}
            onChange={(next) => setSetting({ effort: next || undefined })}
          />
        </SettingsField>
        <SettingsField
          label="Access"
          htmlFor="managed-template-access"
          help={accessUnsupported
            ? `${cliInfo?.displayName ?? 'This CLI'} doesn't support it.`
            : accessValue ? ACCESS_DESCRIPTIONS[accessValue] : 'Not set, so an agent made from it starts at the Default access.'}
          disabled={accessUnsupported}
        >
          <select
            id="managed-template-access"
            data-testid="managed-template-access"
            className={selectClass}
            value={accessValue ?? ''}
            disabled={accessUnsupported}
            onChange={(e) => setAccess(isAccessLevel(e.target.value) ? e.target.value : undefined)}
          >
            <option value="">Not set</option>
            {accessChoices.map((level) => (
              <option key={level} value={level}>
                {accessLabel(level)}{accessLevels.includes(level) ? '' : ' (not available for this CLI)'}
              </option>
            ))}
          </select>
        </SettingsField>
        <SettingsField label="Orchestration" help="Agents made from this template can start helpers.">
          <Toggle checked={orchestrate} onChange={(v) => setOrch({ orchestrate: v })} aria-label="Orchestration" data-testid="managed-template-orchestrate" />
        </SettingsField>
        <SettingsField label="Most helpers at once" htmlFor="managed-template-max-helpers" disabled={!orchestrate}>
          <input
            id="managed-template-max-helpers"
            type="number"
            min={1}
            max={MAX_HELPER_LIMIT}
            step={1}
            className={`${settingsInput} w-[70px]`}
            value={maxDraft}
            disabled={!orchestrate}
            onChange={(e) => setMaxDraft(e.target.value)}
            onBlur={commitMax}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitMax(); } }}
          />
        </SettingsField>
        <SettingsField label="Helper selection" htmlFor="managed-template-helper-selection" help={HELPER_SELECTION_HELP} disabled={!orchestrate}>
          <HelperSelectionSelect
            id="managed-template-helper-selection"
            value={orch.autoHelpers}
            disabled={!orchestrate}
            className={selectClass}
            onChange={(next) => setOrch({ autoHelpers: next })}
          />
        </SettingsField>
        <SettingsField label="Helper template" htmlFor="managed-template-helper-template" help={HELPER_TEMPLATE_HELP} disabled={!orchestrate}>
          <HelperTemplateSelect
            id="managed-template-helper-template"
            value={settings.helperTemplateId ?? ''}
            disabled={!orchestrate}
            className={selectClass}
            onChange={(next) => setSetting({ helperTemplateId: next || undefined })}
          />
        </SettingsField>
        <SettingsField label="Approvals" htmlFor="managed-template-control" disabled={!orchestrate}>
          <ControlSelect
            id="managed-template-control"
            value={orch.control ?? ORCHESTRATION_DEFAULTS.control}
            disabled={!orchestrate}
            className={selectClass}
            onChange={(next) => setOrch({ control: next })}
          />
        </SettingsField>
        <SettingsField label="Helper access" htmlFor="managed-template-helper-access" help="Never more than the agent has when a helper starts." disabled={!orchestrate}>
          <AccessSelect
            id="managed-template-helper-access"
            value={orch.access ?? ORCHESTRATION_DEFAULTS.access}
            access={null}
            running={false}
            name="the agent"
            disabled={!orchestrate}
            className={selectClass}
            onChange={(next) => setOrch({ access: next })}
          />
        </SettingsField>
        <SettingsField label="Connect to Dispatcher" help={DISPATCHER_HELP}>
          <Toggle
            checked={orch.connectToDispatcher ?? orchestrate}
            onChange={(on) => setOrch({ connectToDispatcher: on })}
            aria-label="Connect new agents to the Dispatcher"
            data-testid="managed-template-dispatcher"
          />
        </SettingsField>
        <SettingsField label="Auto-sleep" htmlFor="managed-template-idle-sleep" help={IDLE_SLEEP_HELP}>
          <IdleSleepSelect
            id="managed-template-idle-sleep"
            value={normalizeIdleSleep(settings.idleSleep)}
            className={selectClass}
            onChange={(next) => setSetting({ idleSleep: next === 'inherit' ? undefined : next })}
          />
        </SettingsField>
        <p className={`${settingsHelp} py-2 border-t border-surface-0`}>Agents made from a template always get their own worktree and branch, so there is no workspace setting.</p>
      </SettingsSection>

      <SettingsSection title="Clubhouse permissions">
        <TemplateGrantsSection settings={settings} onChange={(grants) => setSetting({ grants })} />
      </SettingsSection>

      {push && (
        <TemplatePushDialog
          templateName={draft.name}
          changes={push.changes}
          targets={push.targets}
          busy={busy}
          error={error}
          onCancel={() => { setPush(null); setError(null); }}
          onSaveOnly={() => void saveOnly()}
          onSaveAndApply={(targets) => void saveAndApply(targets)}
        />
      )}
    </SettingsPage>
  );
}

/**
 * Settings, Managed agents, Templates (#2898): your templates and the
 * built-in ones, with how many agents were made from each.
 */
export function TemplatesSettingsView() {
  const { value: templates, error } = useManagedTemplates();
  const [editing, setEditing] = useState<TemplateDraft | null>(null);
  const [menu, setMenu] = useState<{ t: ListedTemplate; at: { x: number; y: number } } | null>(null);
  const [deleting, setDeleting] = useState<ListedTemplate | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (editing) {
    return <TemplateEditor key={editing.id ?? 'new'} initial={editing} onDone={(n) => { setEditing(null); setNotice(n ?? null); }} />;
  }

  // Retired built-in templates (D71) aren't listed; agents made from one keep working.
  const all = (templates ?? []).filter(isListed);
  const yours = all.filter((t) => !t.builtin);
  const builtin = all.filter((t) => t.builtin);

  const edit = (t: ListedTemplate) => setEditing({ id: t.id, name: t.name, description: t.description, setup: t.setup, settings: t.settings });
  const copy = async (t: ListedTemplate) => {
    setActionError(null);
    setNotice(null);
    try {
      const made = await unwrap(managed().saveTemplate({ name: copyName(t.name, all.map((x) => x.name)), description: t.description, setup: t.setup, settings: t.settings }));
      setNotice(`Made ${made.name}.`);
    } catch (err) {
      // telemetry-exempt: shown above the lists.
      setActionError(errorText(err));
    }
  };
  const remove = async (t: ListedTemplate) => {
    setDeleting(null);
    setActionError(null);
    try {
      await unwrap(managed().deleteTemplate(t.id));
    } catch (err) {
      // telemetry-exempt: shown above the lists.
      setActionError(errorText(err));
    }
  };

  return (
    <SettingsPage
      title="Templates"
      description="Starting points for new agents and helpers. Agents made from a template aren't linked to it."
      actions={<Button kind="primary" onClick={() => { setNotice(null); setEditing(BLANK); }} data-testid="managed-template-new">New template</Button>}
      testId="managed-templates"
    >
      {notice && <p className={`${settingsHelp} mt-2`} role="status" data-testid="managed-template-notice">{notice}</p>}
      {(error || actionError) && <p role="alert" className={`${settingsError} mt-2`}>{error ?? actionError}</p>}

      <SettingsSection title="Yours" meta={yours.length > 0 ? String(yours.length) : undefined}>
        {templates === null && !error && <p className={`${settingsHelp} py-2`}>Loading…</p>}
        {templates !== null && yours.length === 0 && (
          <p className={`${settingsHelp} py-2 border-t border-surface-0`}>None yet. Make a new one, copy a built-in, or use Save as template in any agent's builder.</p>
        )}
        <ul data-testid="managed-templates-yours">
          {yours.map((t) => (
            <TemplateRow key={t.id} t={t}>
              <Button kind="quiet" aria-label={`Edit ${t.name}`} onClick={() => edit(t)}>Edit</Button>
              <Button kind="quiet" aria-label={`Fork ${t.name}`} onClick={() => void copy(t)}>Fork</Button>
              <Button
                kind="quiet"
                icon={<MoreIcon />}
                aria-label={`More for ${t.name}`}
                aria-haspopup="menu"
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ t, at: { x: r.left, y: r.bottom + 4 } }); }}
              />
            </TemplateRow>
          ))}
        </ul>
      </SettingsSection>

      <ProjectTemplatesSection onNotice={(text) => { setActionError(null); setNotice(text); }} />

      <SettingsSection title="Built-in" meta={builtin.length > 0 ? String(builtin.length) : undefined}>
        <ul data-testid="managed-templates-builtin">
          {builtin.map((t) => (
            <TemplateRow key={t.id} t={t}>
              <Button kind="quiet" aria-label={`Make your copy of ${t.name}`} onClick={() => void copy(t)}>Make your copy</Button>
            </TemplateRow>
          ))}
        </ul>
      </SettingsSection>

      {menu && (
        <PopupMenu
          label={`${menu.t.name} actions`}
          testId="managed-template-menu"
          position={menu.at}
          onClose={() => setMenu(null)}
          items={[{ id: 'delete', label: 'Delete', danger: true, onSelect: () => setDeleting(menu.t) }]}
        />
      )}
      <ConfirmDestructiveAction
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? ''}?`}
        description={`Agents made from ${deleting?.name ?? 'it'} keep their setup. New agents can't start from it.`}
        confirmLabel="Delete"
        onCancel={() => setDeleting(null)}
        onConfirm={() => { if (deleting) void remove(deleting); }}
      />
    </SettingsPage>
  );
}
