import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { Field, SectionHeading, inputClass, selectClass } from '../agents/agentSettingsUi';
import { isListed, type ManagedAgentSetup, type ManagedConvertPreview } from '../../../shared/managed-agents-types';
import { errorText, managed, unwrap, useManagedStatus, useManagedTemplates } from './managedApi';
import { legacyLine, migratedLine, migrationFailedLine, type LegacyUse } from './legacy';

/**
 * General › Setup for an agent (#2893). Managed: which template it came from,
 * Save as template, Stop managing. Unmanaged: the switch to managed, and the
 * Clubhouse features opt-out, which turns off hooks only. An unmanaged agent that still
 * names a persona says so, as the offer to switch (#2901), and one whose
 * automatic switch failed gives the reason. An agent Clubhouse switched on
 * its own says so until the notice is dismissed (D59).
 */
export function ManagedGeneralSection({ projectPath, agentId, agentName, setup, clubhouseFeatures, onClubhouseFeaturesChange, isRunning, legacy }: {
  projectPath: string;
  agentId: string;
  agentName: string;
  setup: ManagedAgentSetup | null;
  clubhouseFeatures: boolean;
  /** Called with the saved value once the switch's change is saved. */
  onClubhouseFeaturesChange?: (on: boolean) => void;
  isRunning: boolean;
  /** The persona the unmanaged agent still names, if any. */
  legacy?: LegacyUse | null;
}) {
  const templates = useManagedTemplates();
  const { value: status } = useManagedStatus(projectPath, agentId);
  const [convertOpen, setConvertOpen] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { /* telemetry-exempt: shown to the person beside the control */ setError(errorText(err)); } finally { setBusy(false); }
  };
  const templateName = setup?.templateId ? templates.value?.find((t) => t.id === setup.templateId)?.name : undefined;

  return (
    <>
      <SectionHeading title="Setup" sub={isRunning && setup ? 'Changes apply when the next session starts' : undefined} />
      {setup ? (
        <>
          <Field label="Clubhouse managed" help={templateName ? `On. Started from the ${templateName} template.` : 'On. Clubhouse writes its instructions, skills and MCP servers at each start.'} testId="managed-general-on">
            <Button onClick={() => setSaveAsOpen(true)} disabled={busy}>Save as template…</Button>
            <Button kind="quiet" onClick={() => setConfirmStop(true)} disabled={busy}>Stop managing</Button>
          </Field>
          {status?.migrated && (
            <div className="flex items-center gap-6 py-2 border-t border-surface-0" data-testid="managed-general-migrated">
              <p className="flex-1 min-w-0 text-xs text-ctp-subtext1">{migratedLine(status.migrated.backup)}</p>
              <Button kind="quiet" onClick={() => void run(() => unwrap(managed().dismissMigrationNotice(projectPath, agentId)))} disabled={busy}>Dismiss</Button>
            </div>
          )}
        </>
      ) : (
        <>
          <Field
            label="Clubhouse managed"
            help={<>
              {legacy
                ? <span data-testid="managed-general-legacy">{legacyLine(agentName, legacy)} Switch to managed keeps what it has now.</span>
                : `Off. ${agentName} uses the instructions, skills and MCP config in its folder, and Clubhouse doesn't change them.`}
              {status?.migrationFailed && <span className="block mt-px" data-testid="managed-general-migration-failed">{migrationFailedLine(status.migrationFailed)}</span>}
            </>}
            testId="managed-general-off"
          >
            <Button onClick={() => setConvertOpen(true)} disabled={busy}>Switch to managed…</Button>
          </Field>
          <Field
            label="Clubhouse features"
            help={clubhouseFeatures
              ? 'Status and permission prompts. Clubhouse tools (helpers, messages, Dispatcher) are always on.'
              : <span className="text-ctp-warning">Off: Clubhouse can't show this agent's status, permission prompts or changes.</span>}
            testId="managed-clubhouse-features"
          >
            <Toggle
              checked={clubhouseFeatures}
              onChange={(on) => void run(async () => {
                await unwrap(managed().setClubhouseFeatures(projectPath, agentId, on));
                onClubhouseFeaturesChange?.(on);
              })}
              disabled={busy || isRunning}
              aria-label="Clubhouse features"
            />
          </Field>
        </>
      )}
      {error && <p role="alert" className="text-xs text-ctp-error mt-1">{error}</p>}

      {convertOpen && (
        <ConvertDialog
          projectPath={projectPath}
          agentId={agentId}
          agentName={agentName}
          templates={(templates.value ?? []).filter(isListed).map((t) => ({ id: t.id, name: t.name }))}
          busy={busy}
          error={error}
          onCancel={() => setConvertOpen(false)}
          onConvert={(keep, templateId) => void run(async () => {
            await unwrap(managed().convertAgent(projectPath, agentId, keep, templateId));
            setConvertOpen(false);
          })}
        />
      )}
      {saveAsOpen && (
        <SaveAsTemplateDialog
          agentName={agentName}
          busy={busy}
          error={error}
          onCancel={() => setSaveAsOpen(false)}
          onSave={(name) => void run(async () => {
            await unwrap(managed().templateFromAgent(projectPath, agentId, name));
            setSaveAsOpen(false);
          })}
        />
      )}
      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={`Stop managing ${agentName}?`}
        footer={<>
          <Button onClick={() => setConfirmStop(false)} disabled={busy}>Cancel</Button>
          <Button kind="primary" disabled={busy} onClick={() => void run(async () => { await unwrap(managed().unmanage(projectPath, agentId)); setConfirmStop(false); })}>Stop managing</Button>
        </>}
      >
        <p className="text-[13px] text-ctp-subtext1">{agentName} keeps the files Clubhouse last wrote, and they become yours to manage. Its parts stay in the library.</p>
      </Modal>
    </>
  );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "Becomes: 1 block, skills release-notes, review, MCP servers github." */
export function convertSummary(p: Pick<ManagedConvertPreview, 'blocks' | 'skills' | 'mcps'>): string {
  const parts = [
    ...(p.blocks.length > 0 ? [`${p.blocks.length} ${plural(p.blocks.length, 'block', 'blocks')}`] : []),
    ...(p.skills.length > 0 ? [`${plural(p.skills.length, 'skill', 'skills')} ${p.skills.join(', ')}`] : []),
    ...(p.mcps.length > 0 ? [`${plural(p.mcps.length, 'MCP server', 'MCP servers')} ${p.mcps.join(', ')}`] : []),
  ];
  return parts.length > 0 ? `Becomes: ${parts.join(', ')}.` : 'It has no instructions, skills or MCP servers to bring over yet.';
}

/** What Keep would bring over, read when the dialog opens. Nothing is written until Switch to managed. */
function useConvertPreview(projectPath: string, agentId: string): { preview: ManagedConvertPreview | null; error: string | null } {
  const [preview, setPreview] = useState<ManagedConvertPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    unwrap(managed().previewConvert(projectPath, agentId))
      .then((p) => { if (!cancelled) setPreview(p); })
      .catch((err) => { /* telemetry-exempt: shown to the person in the dialog */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [projectPath, agentId]);
  return { preview, error };
}

function ConvertDialog({ projectPath, agentId, agentName, templates, busy, error, onCancel, onConvert }: {
  projectPath: string;
  agentId: string;
  agentName: string;
  templates: Array<{ id: string; name: string }>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConvert: (keep: boolean, templateId?: string) => void;
}) {
  const [keep, setKeep] = useState(true);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const { preview, error: previewError } = useConvertPreview(projectPath, agentId);
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Switch ${agentName} to Clubhouse managed`}
      width="w-[560px]"
      testId="managed-convert-dialog"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" disabled={busy || (keep ? !preview : !templateId)} onClick={() => onConvert(keep, keep ? undefined : templateId)}>Switch to managed</Button>
      </>}
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <label className="flex gap-2.5 items-start cursor-pointer">
          <input type="radio" name="convert" checked={keep} onChange={() => setKeep(true)} className="mt-1" />
          <span className="flex-1"><span className="font-semibold text-ctp-text">Keep what {agentName} has now</span><br />
            <span className="text-xs text-ctp-overlay1">Its instructions file, skills and MCP servers become parts for {agentName} only. The original instructions file is kept in Clubhouse's app data.</span>
            {keep && (
              <span className="mt-2 flex flex-col gap-1 text-xs" data-testid="managed-convert-preview">
                {!preview && !previewError && <span className="text-ctp-overlay1">Reading what it has…</span>}
                {previewError && <span role="alert" className="text-ctp-error">{previewError}</span>}
                {preview && <span className="text-ctp-subtext1" data-testid="managed-convert-summary">{convertSummary(preview)}</span>}
                {preview?.notes.map((n) => <span key={n} className="text-ctp-warning">{n}</span>)}
              </span>
            )}
          </span>
        </label>
        <label className="flex gap-2.5 items-start cursor-pointer">
          <input type="radio" name="convert" checked={!keep} onChange={() => setKeep(false)} className="mt-1" />
          <span className="flex-1"><span className="font-semibold text-ctp-text">Start with a template</span><br />
            <span className="text-xs text-ctp-overlay1">Replaces {agentName}'s setup with the template's parts and settings.</span>
            {!keep && (
              <select className={`${selectClass} mt-2 block`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Template">
                {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </span>
        </label>
        <p className="text-xs text-ctp-overlay1">Nothing changes until you switch. {agentName} keeps its name, history and branch, and the change applies when its next session starts.</p>
        {error && <p role="alert" className="text-xs text-ctp-error">{error}</p>}
      </div>
    </Modal>
  );
}

function SaveAsTemplateDialog({ agentName, busy, error, onCancel, onSave }: {
  agentName: string; busy: boolean; error: string | null; onCancel: () => void; onSave: (name: string) => void;
}) {
  const [name, setName] = useState(`${agentName} setup`);
  return (
    <Modal
      open
      onClose={onCancel}
      title="Save as template"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" disabled={busy || !name.trim()} onClick={() => onSave(name.trim())}>Save template</Button>
      </>}
    >
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="text-ctp-subtext1">Name</span>
        <input className={`${inputClass} w-full`} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <span className="text-xs text-ctp-overlay1">Saves {agentName}'s parts and settings. New agents can start from it; it doesn't change {agentName}.</span>
      </label>
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
