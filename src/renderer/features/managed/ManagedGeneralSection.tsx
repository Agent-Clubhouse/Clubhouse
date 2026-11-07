import { useState } from 'react';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { Toggle } from '../../components/Toggle';
import { Field, SectionHeading, inputClass, selectClass } from '../agents/agentSettingsUi';
import type { ManagedAgentSetup } from '../../../shared/managed-agents-types';
import { errorText, managed, unwrap, useManagedTemplates } from './managedApi';

/**
 * General › Setup for an agent (#2893). Managed: which template it came from,
 * Save as template, Stop managing. Unmanaged: the switch to managed, and the
 * Clubhouse features opt-out for a plain CLI.
 */
export function ManagedGeneralSection({ projectPath, agentId, agentName, setup, clubhouseFeatures, isRunning }: {
  projectPath: string;
  agentId: string;
  agentName: string;
  setup: ManagedAgentSetup | null;
  clubhouseFeatures: boolean;
  isRunning: boolean;
}) {
  const templates = useManagedTemplates();
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
        </>
      ) : (
        <>
          <Field label="Clubhouse managed" help={`Off. ${agentName} uses the instructions, skills and MCP config in its folder, and Clubhouse doesn't change them.`} testId="managed-general-off">
            <Button onClick={() => setConvertOpen(true)} disabled={busy}>Switch to managed…</Button>
          </Field>
          <Field
            label="Clubhouse features"
            help={clubhouseFeatures
              ? 'Status, permission prompts and Clubhouse tools (helpers, messages, Dispatcher).'
              : <span className="text-ctp-warning">Off: Clubhouse can't show this agent's status, permission prompts or changes, and it can't use helpers, messages or the Dispatcher.</span>}
            testId="managed-clubhouse-features"
          >
            <Toggle
              checked={clubhouseFeatures}
              onChange={(on) => void run(() => unwrap(managed().setClubhouseFeatures(projectPath, agentId, on)))}
              disabled={busy || isRunning}
              aria-label="Clubhouse features"
            />
          </Field>
        </>
      )}
      {error && <p role="alert" className="text-xs text-ctp-error mt-1">{error}</p>}

      {convertOpen && (
        <ConvertDialog
          agentName={agentName}
          templates={(templates.value ?? []).map((t) => ({ id: t.id, name: t.name }))}
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

function ConvertDialog({ agentName, templates, busy, error, onCancel, onConvert }: {
  agentName: string;
  templates: Array<{ id: string; name: string }>;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConvert: (keep: boolean, templateId?: string) => void;
}) {
  const [keep, setKeep] = useState(true);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  return (
    <Modal
      open
      onClose={onCancel}
      title={`Switch ${agentName} to Clubhouse managed`}
      width="w-[560px]"
      testId="managed-convert-dialog"
      footer={<>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button kind="primary" disabled={busy || (!keep && !templateId)} onClick={() => onConvert(keep, keep ? undefined : templateId)}>Switch to managed</Button>
      </>}
    >
      <div className="flex flex-col gap-3 text-[13px]">
        <label className="flex gap-2.5 items-start cursor-pointer">
          <input type="radio" name="convert" checked={keep} onChange={() => setKeep(true)} className="mt-1" />
          <span><span className="font-semibold text-ctp-text">Keep what {agentName} has now</span><br />
            <span className="text-xs text-ctp-overlay1">Its instructions file becomes a block for {agentName} only, and the original is kept in Clubhouse's app data. You can add skills and MCP servers next.</span></span>
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
        <p className="text-xs text-ctp-overlay1">{agentName} keeps its name, history and branch. The change applies when its next session starts.</p>
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
