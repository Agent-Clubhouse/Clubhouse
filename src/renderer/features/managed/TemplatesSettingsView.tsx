import { useState } from 'react';
import type { ManagedTemplate, ManagedTemplateChange, ManagedTemplatePushTarget } from '../../../shared/managed-agents-types';
import { DEFAULT_MAX_HELPERS, MAX_HELPER_LIMIT } from '../../../shared/orchestration-policy';
import { Button } from '../../components/Button';
import { ConfirmDestructiveAction } from '../../components/ConfirmDestructiveAction';
import { PopupMenu } from '../../components/PopupMenu';
import { Toggle } from '../../components/Toggle';
import { SettingsField, SettingsPage, SettingsSection, settingsError, settingsHelp, settingsInput } from '../settings/SettingsLayout';
import { ManagedBuilder, type SetupDraft } from './ManagedBuilder';
import { TemplatePushDialog } from './TemplatePushDialog';
import { errorText, managed, unwrap, useManagedTemplates } from './managedApi';

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

const usage = (n: number) => (n === 0 ? 'No agents' : `${n} agent${n === 1 ? '' : 's'}`);

function TemplateRow({ t, children }: { t: ListedTemplate; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_minmax(0,90px)_auto] gap-x-4 items-center py-2 border-t border-surface-0" data-testid="managed-template-row">
      <span className="min-w-0">
        <span className="block text-[13px] text-ctp-text truncate">{t.name}</span>
        {t.description && <span className="block text-xs text-ctp-overlay1 truncate">{t.description}</span>}
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [push, setPush] = useState<{ changes: ManagedTemplateChange[]; targets: ManagedTemplatePushTarget[] } | null>(null);
  const orch = draft.settings.orchestration ?? {};
  const orchestrate = orch.orchestrate === true;
  const [maxDraft, setMaxDraft] = useState(String(orch.maxHelpers ?? DEFAULT_MAX_HELPERS));

  const setSetup = (setup: SetupDraft) => setDraft((d) => ({ ...d, setup: { blocks: setup.blocks, skills: setup.skills, mcps: setup.mcps } }));
  const setOrch = (patch: Partial<NonNullable<TemplateDraft['settings']['orchestration']>>) =>
    setDraft((d) => ({ ...d, settings: { ...d.settings, orchestration: { ...(d.settings.orchestration ?? {}), ...patch } } }));
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
        <div role="tablist" aria-label="Template parts" className="flex items-center gap-0.5 mb-2 border-b border-surface-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`h-8 px-2.5 -mb-px border-b-2 text-xs cursor-pointer ${tab === t.id ? 'border-ctp-text text-ctp-text' : 'border-transparent text-ctp-subtext0 hover:text-ctp-text'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div role="tabpanel">
          <ManagedBuilder target={{ kind: 'draft', value: draft.setup, onChange: setSetup, agentName: draft.name || 'the agent' }} tab={tab} />
        </div>
      </SettingsSection>

      <SettingsSection title="Settings">
        <SettingsField label="Orchestration" help="Agents made from this template can start helpers. They need the Clubhouse MCP server.">
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

  const all = templates ?? [];
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
