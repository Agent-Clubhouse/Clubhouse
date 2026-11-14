import { useEffect, useState } from 'react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { inputClass } from '../agents/agentSettingsUi';
import { SettingsSection, settingsHelp } from '../settings/SettingsLayout';
import {
  PROJECT_PARTS_FOLDER,
  type ManagedTemplatePushTarget,
  type ProjectTemplateItem,
  type ProjectTemplateReview,
  type ProjectTemplatesInventory,
} from '../../../shared/managed-agents-types';
import { errorText, managed, partKindLabel, unwrap } from './managedApi';
import { changeText, TemplatePushDialog } from './TemplatePushDialog';

function stateText(item: ProjectTemplateItem): string {
  switch (item.state) {
    case 'available': return 'Not added yet';
    case 'added': return `Added as ${item.templateName}`;
    case 'changed': return `Changed in the repository since it was added as ${item.templateName}`;
    case 'kept': return `Changed in the repository. You kept ${item.templateName} as it is`;
    case 'refused': return `Can't be added. ${item.problem ?? ''}`.trim();
  }
}

/** Every registered project's checked-in templates, read again whenever managed parts or templates change. */
function useProjectTemplates(): { value: ProjectTemplatesInventory[] | null; reload: () => void } {
  const [value, setValue] = useState<ProjectTemplatesInventory[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void unwrap(managed().projectTemplates())
        .then((v) => { if (!cancelled) setValue(v); })
        .catch(() => { /* telemetry-exempt: the section just stays hidden */ if (!cancelled) setValue([]); });
    };
    load();
    const off = managed().onChanged(load);
    return () => { cancelled = true; off(); };
  }, [tick]);
  return { value, reload: () => setTick((t) => t + 1) };
}

/**
 * Settings, Templates: templates registered projects check in under
 * `.clubhouse/parts/templates/` (D255). Nothing is added, and no agent
 * changes, until the person reviews and picks.
 */
export function ProjectTemplatesSection({ onNotice }: { onNotice: (text: string) => void }) {
  const { value, reload } = useProjectTemplates();
  const [open, setOpen] = useState<{ projectPath: string; item: ProjectTemplateItem } | null>(null);
  if (!value || value.length === 0) return null;
  return (
    <SettingsSection title="From project repositories">
      <p className={`${settingsHelp} py-2 border-t border-surface-0`}>
        Projects can check templates in under {PROJECT_PARTS_FOLDER}/templates. Clubhouse only reads them. A change there waits for you to review it.
      </p>
      {value.map((inv) => (
        <div key={inv.projectId} data-testid="managed-project-templates" data-project={inv.projectName}>
          <h4 className="text-xs font-medium text-ctp-subtext1 pt-2">{inv.projectName}</h4>
          <ul>
            {inv.items.map((item) => (
              <li key={item.key} data-testid="managed-project-template-row" data-state={item.state} className="flex items-center gap-2.5 py-2 border-t border-surface-0">
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ctp-text truncate">{item.name}</div>
                  <div className={`text-xs ${item.state === 'changed' ? 'text-ctp-warning' : item.state === 'refused' ? 'text-ctp-error' : 'text-ctp-overlay1'}`}>{stateText(item)}</div>
                </div>
                {item.state === 'available' && <Button onClick={() => setOpen({ projectPath: inv.projectPath, item })} aria-label={`Review ${item.name}`}>Review</Button>}
                {(item.state === 'changed' || item.state === 'kept') && <Button onClick={() => setOpen({ projectPath: inv.projectPath, item })} aria-label={`Review the change to ${item.name}`}>Review change</Button>}
              </li>
            ))}
            {inv.gone.map((g) => (
              <li key={g.key} data-testid="managed-project-template-gone" className="py-2 border-t border-surface-0">
                <div className="text-[13px] text-ctp-text truncate">{g.templateName}</div>
                <div className="text-xs text-ctp-overlay1">
                  {g.unsure
                    ? 'Not found in the repository. It may be in a file that can\'t be read. The template stays, and so do agents made from it.'
                    : 'No longer in the repository. The template stays, and so do agents made from it.'}
                </div>
              </li>
            ))}
          </ul>
          {inv.notes.length > 0 && <ul className="text-xs text-ctp-overlay1">{inv.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </div>
      ))}
      {open && (
        <ProjectTemplateDialog
          projectPath={open.projectPath}
          item={open.item}
          onClose={() => setOpen(null)}
          onDone={(text) => { setOpen(null); reload(); onNotice(text); }}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Review one repository template: its parts as they resolve here, settings,
 * and permissions apart behind their own tick. A change goes on to the
 * template push dialog, where the person picks which agents get it.
 */
export function ProjectTemplateDialog({ projectPath, item, onClose, onDone }: {
  projectPath: string;
  item: ProjectTemplateItem;
  onClose: () => void;
  onDone: (notice: string) => void;
}) {
  const [approve, setApprove] = useState(false);
  const [review, setReview] = useState<ProjectTemplateReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [pushing, setPushing] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void unwrap(managed().reviewProjectTemplate(projectPath, item.key, approve))
      .then((r) => { if (!cancelled) { setReview(r); setName((n) => n || r.suggestedName); } })
      .catch((err) => { /* telemetry-exempt: shown to the person */ if (!cancelled) setError(errorText(err)); });
    return () => { cancelled = true; };
  }, [projectPath, item.key, approve]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (err) { /* telemetry-exempt: shown to the person */ setError(errorText(err)); } finally { setBusy(false); }
  };
  const hash = review?.item.hash ?? '';
  const unresolved = review?.refs.filter((r) => r.unresolved) ?? [];
  const change = review?.current;
  const add = () => run(async () => {
    const made = await unwrap(managed().addProjectTemplate(projectPath, item.key, hash, { name, approvePermissions: approve }));
    onDone(`Added ${made.name}.`);
  });
  const keep = () => run(async () => {
    await unwrap(managed().keepProjectTemplate(projectPath, change!.id, hash));
    onDone(`Kept ${change!.name} as it is.`);
  });
  const update = (targets: ManagedTemplatePushTarget[]) => run(async () => {
    const { failed } = await unwrap(managed().updateProjectTemplate(projectPath, change!.id, hash, { approvePermissions: approve, targets: targets.map((t) => ({ projectPath: t.projectPath, agentId: t.agentId })) }));
    onDone(failed.length === 0
      ? `Updated ${change!.name}${targets.length > 0 ? ` and applied it to ${targets.length} agent${targets.length === 1 ? '' : 's'}` : ''}.`
      : `Updated ${change!.name}. Couldn't apply it to ${failed.map((f) => f.agentId).join(', ')}.`);
  });

  if (pushing && review?.push && change) {
    return (
      <TemplatePushDialog
        templateName={change.name}
        changes={review.push.changes}
        targets={review.push.targets}
        busy={busy}
        error={error}
        onCancel={() => setPushing(false)}
        onSaveOnly={() => void update([])}
        onSaveAndApply={(targets) => void update(targets)}
      />
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      busy={busy}
      title={change ? `${item.name} changed in the repository` : `Add ${item.name} from the repository`}
      width="w-[600px]"
      testId="managed-project-template-dialog"
      footer={(dismiss) => change ? <>
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button onClick={() => void keep()} disabled={busy || !review} data-testid="managed-project-template-keep">Keep mine</Button>
        <Button kind="primary" onClick={() => setPushing(true)} disabled={busy || !review?.push || unresolved.length > 0} data-testid="managed-project-template-continue">Choose agents</Button>
      </> : <>
        <Button onClick={dismiss} disabled={busy}>Cancel</Button>
        <Button kind="primary" onClick={() => void add()} disabled={busy || !review || unresolved.length > 0 || !name.trim()} data-testid="managed-project-template-add">Add template</Button>
      </>}
    >
      {!review && !error && <p className="text-[13px] text-ctp-overlay1">Reading the repository.</p>}
      {review && (
        <div className="flex flex-col gap-3 text-[13px]">
          {review.description && <p className="text-ctp-subtext1">{review.description}</p>}
          {change && <p className="text-ctp-subtext1">{change.consumers > 0 ? `${change.consumers} agent${change.consumers === 1 ? ' was' : 's were'} made from ${change.name}. You pick which get the changes next.` : `No agent was made from ${change.name} yet.`}</p>}
          <section>
            <h3 className="text-xs font-medium text-ctp-subtext1 mb-1">Parts</h3>
            <ul data-testid="managed-project-template-refs" className="flex flex-col gap-0.5 text-xs">
              {review.refs.map((r) => (
                <li key={`${r.kind}-${r.ref}`} data-unresolved={r.unresolved ?? undefined} className={r.unresolved ? 'text-ctp-warning' : 'text-ctp-text'}>
                  {partKindLabel(r.kind)} {r.partName ?? r.ref}
                  {r.unresolved === 'not_added' && ' isn\'t in the library yet. Add it from the project first.'}
                  {r.unresolved === 'missing' && ' isn\'t a part in this repository or a built-in.'}
                </li>
              ))}
              {review.refs.length === 0 && <li className="text-ctp-overlay1">None besides the Clubhouse MCP part every setup has.</li>}
            </ul>
          </section>
          {review.settings.length > 0 && (
            <section>
              <h3 className="text-xs font-medium text-ctp-subtext1 mb-1">Settings</h3>
              <ul data-testid="managed-project-template-settings" className="flex flex-col gap-0.5 font-mono text-xs text-ctp-text">{review.settings.map((c, i) => <li key={i}>{changeText(c)}</li>)}</ul>
            </section>
          )}
          {review.permissions.length > 0 && (
            <section data-testid="managed-project-template-permissions">
              <h3 className="text-xs font-medium text-ctp-subtext1 mb-1">Permissions</h3>
              <ul className="flex flex-col gap-0.5 font-mono text-xs text-ctp-text">{review.permissions.map((c, i) => <li key={i}>{changeText(c)}</li>)}</ul>
              <label className="mt-1.5 flex items-center gap-2 text-xs text-ctp-text">
                <input type="checkbox" checked={approve} onChange={(e) => setApprove(e.target.checked)} disabled={busy} data-testid="managed-project-template-approve" />
                Include these permissions
              </label>
              <p className="mt-0.5 text-xs text-ctp-overlay1">
                {change ? 'Left unticked, the template keeps the permissions it has now.' : 'Left unticked, the template is added without them.'} An agent's own permission choices always stay as they are.
              </p>
            </section>
          )}
          {review.notes.length > 0 && <ul className="text-xs text-ctp-overlay1">{review.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          {!change && (
            <label className="flex flex-col gap-1 text-xs text-ctp-subtext1">
              Template name
              <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} aria-label="Template name" data-testid="managed-project-template-name" />
            </label>
          )}
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-ctp-error">{error}</p>}
    </Modal>
  );
}
