import { useState } from 'react';
import type { ActionView } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { Toggle } from '../../components/Toggle';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { useGroupProjectStore } from '../../stores/groupProjectStore';
import { ActionCard, statusLine } from '../actions/ActionCard';
import { ActionForm } from '../actions/ActionForm';
import { useActionsList } from '../actions/useActions';
import { SettingsBlock, SettingsSection, settingsError, settingsHelp } from '../settings/SettingsLayout';

type FormState = { action?: ActionView } | null;

/**
 * A group project's Actions. They belong to the group project, not to the
 * agent that made them, and run on the computer that holds it: on that
 * computer they are made and edited here, with the same card and form as
 * Settings > Actions. On a copy they are the host's read-only summaries.
 */
export function GroupProjectActionsSection({ groupProjectId }: { groupProjectId: string }) {
  const project = useGroupProjectStore((s) => s.projects.find((p) => p.id === groupProjectId));
  return (
    <SettingsSection title="Actions">
      <SettingsBlock>
        {project?.network?.role === 'replica'
          ? <HostActionSummaries groupProjectId={groupProjectId} hostName={project.hostName ?? 'the computer that holds it'} />
          : <LocalActions groupProjectId={groupProjectId} />}
      </SettingsBlock>
    </SettingsSection>
  );
}

function LocalActions({ groupProjectId }: { groupProjectId: string }) {
  const { actions, error, reload } = useActionsList();
  const [cardId, setCardId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(null);
  const owned = actions?.filter((action) => action.owner.kind === 'group_project' && action.owner.groupProjectId === groupProjectId) ?? [];
  const card = cardId ? owned.find((action) => action.id === cardId) : undefined;
  return (
    <>
      <p className={`${settingsHelp} mb-2`}>Runs on this computer. These Actions stay with the group project if the agent that made one leaves.</p>
      {error && <p role="alert" className={settingsError}>Could not load Actions. {error} <Button onClick={reload}>Retry</Button></p>}
      {!actions && !error && <p className={settingsHelp}>Loading Actions...</p>}
      {actions && owned.length === 0 && <p className={settingsHelp}>No Actions yet.</p>}
      {owned.length > 0 && (
        <ul aria-label="Group project Actions">
          {owned.map((action) => <ActionRow key={action.id} action={action} onOpen={() => setCardId(action.id)} />)}
        </ul>
      )}
      <Button className="mt-2" onClick={() => setForm({})}>New action</Button>
      {card && <ActionCard action={card} onClose={() => setCardId(null)} onEdit={() => { setCardId(null); setForm({ action: card }); }} />}
      <ActionForm open={!!form} action={form?.action} initialGroupProjectId={groupProjectId} onClose={() => setForm(null)} />
    </>
  );
}

function ActionRow({ action, onOpen }: { action: ActionView; onOpen: () => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex items-start gap-3 py-2 border-t border-surface-0" data-testid="group-project-action-row">
      <Toggle
        className="mt-0.5"
        checked={action.enabled}
        aria-label={`${action.name} on or off`}
        onChange={(on) => {
          setError(null);
          window.clubhouse.actions.setEnabled(action.id, on).catch((err: unknown) => {
            // telemetry-exempt: shown on the row; the switch keeps the saved state
            setError(ipcErrorMessage(err));
          });
        }}
      />
      <button type="button" className="flex-1 min-w-0 text-left cursor-pointer group" onClick={onOpen}>
        <span className="block text-[13px] text-ctp-text truncate group-hover:underline">{action.name}</span>
        <span className="block text-xs text-ctp-overlay1 truncate">{statusLine(action)}</span>
        {error && <span role="alert" className={`block ${settingsError}`}>{error}</span>}
      </button>
    </li>
  );
}

/** What the host shares with its network: names and plain-language summaries, never a way to edit. */
function HostActionSummaries({ groupProjectId, hostName }: { groupProjectId: string; hostName: string }) {
  const satellites = useAnnexClientStore((s) => s.satellites);
  const summaries = satellites.flatMap((satellite) => {
    const list = satellite.snapshot?.groupProjectActions;
    return Array.isArray(list) ? list.filter((a) => a && a.groupProjectId === groupProjectId && typeof a.name === 'string') : [];
  });
  return (
    <>
      <p className={settingsHelp}>Runs on {hostName}. Read-only here. Manage Actions on {hostName} to edit them.</p>
      {summaries.length === 0
        ? <p className={`${settingsHelp} mt-2`}>Unavailable. {hostName} has not shared a summary of these Actions with this computer.</p>
        : (
          <ul aria-label={`Group project Actions on ${hostName}`} className="mt-2">
            {summaries.map((action) => (
              <li key={action.id} className="py-2 border-t border-surface-0 text-xs text-ctp-subtext1">
                <span className="text-ctp-text">{action.name}</span>{action.enabled ? '' : ' (off)'}
                {typeof action.description === 'string' && <p className="text-ctp-overlay1">{action.description}</p>}
              </li>
            ))}
          </ul>
        )}
    </>
  );
}
