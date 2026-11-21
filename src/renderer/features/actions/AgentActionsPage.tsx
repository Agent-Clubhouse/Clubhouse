/**
 * Agent settings > Actions (#2954), and every agent's Actions card in
 * Agent details: the actions that involve one agent, in three groups.
 */

import { agentActionGroups } from '../../../shared/agent-action-groups';
import { ActionGroupFrame, ActionLineContent } from './ActionListPresentation';
import { useState } from 'react';
import { describeAction, type ActionInput, type ActionView } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { settingsHelp } from '../settings/SettingsLayout';
import { CardNote, DetailsCard } from '../agents/details/DetailsCard';
import { ActionCard } from './ActionCard';
import { ActionForm } from './ActionForm';
import { openActionsSettings, useActionNames, useActionsList } from './useActions';

export { agentActionGroups, type AgentActionGroups } from '../../../shared/agent-action-groups';

function ActionLine({ action, onOpen }: { action: ActionView; onOpen?: (id: string) => void }) {
  const { names } = useActionNames();
  return (
    <li className="py-2 border-t border-surface-0">
      <button type="button" className="w-full text-left cursor-pointer group" onClick={() => onOpen ? onOpen(action.id) : openActionsSettings({ cardId: action.id })} data-testid="agent-action-row">
        <ActionLineContent name={action.name} enabled={action.enabled} description={describeAction(action, names)} lastRun={action.lastRun} />
      </button>
    </li>
  );
}

function Group({ title, empty, list, note, onOpen }: { title: string; empty: string; list: ActionView[]; note?: string; onOpen?: (id: string) => void }) {
  return <ActionGroupFrame title={title} empty={empty} hasItems={list.length > 0} note={note}>
    {list.map((a) => <ActionLine key={a.id} action={a} onOpen={onOpen} />)}
  </ActionGroupFrame>;
}

/** A new action pre-filled for this agent: every weekday, wake it. */
export function newActionFor(agentId: string): Partial<ActionInput> {
  return {
    trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' },
    steps: [{ kind: 'wake', agentId }],
  };
}

export function AgentActionsPage({ agentId, agentName, projectId }: { agentId: string; agentName: string; projectId?: string }) {
  const { actions, error } = useActionsList();
  const groups = agentActionGroups(actions ?? [], agentId, projectId);
  return (
    <div data-testid="agent-actions-page">
      <div className="flex items-center gap-3">
        <div className={`${settingsHelp} flex-1`}>Workflows that run on a schedule, when something happens, or once.</div>
        <Button kind="ghost" onClick={() => openActionsSettings({ draft: newActionFor(agentId) })}>New action for {agentName}</Button>
      </div>
      {error && <div className={`${settingsHelp} mt-3`}>Couldn’t load actions. {error}</div>}
      {actions && (
        <>
          <Group title={`Targets ${agentName}`} empty={`No action targets ${agentName}.`} list={groups.targeting} />
          <Group title={`Set off by ${agentName}`} empty={`Nothing ${agentName} does sets off an action.`} list={groups.triggeredBy} />
          <Group title={`Owned by ${agentName}`} empty={`${agentName} doesn’t own any actions.`} list={groups.owned} note={`Their usage counts toward ${agentName}.`} />
        </>
      )}
    </div>
  );
}

/** Uses the same user-authorized management UI and IPC as Settings > Actions. */
export function AgentActionsCard({ agentId, agentName, projectId, open, onToggle }: {
  agentId: string;
  agentName: string;
  projectId?: string;
  open: boolean;
  onToggle: () => void;
}) {
  const { actions, error, reload } = useActionsList();
  const groups = agentActionGroups(actions ?? [], agentId, projectId);
  const related = new Set([...groups.owned, ...groups.targeting, ...groups.triggeredBy].map((a) => a.id)).size;
  const [cardId, setCardId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ActionView | null>(null);
  const card = actions?.find((a) => a.id === cardId);
  return (
    <>
      <DetailsCard id="actions" title="Actions" summary={actions ? `${related} related` : error ? 'couldn’t load' : 'loading'} open={open} onToggle={onToggle}>
        {error && <CardNote><span role="alert">Couldn’t load actions. {error}</span> <Button kind="ghost" onClick={reload}>Try again</Button></CardNote>}
        {!actions && !error && <CardNote>Loading actions.</CardNote>}
        {actions && related === 0 && <CardNote>No actions are owned by, target or are set off by {agentName}.</CardNote>}
        {actions && related > 0 && (
          <div className="px-3 pb-1">
            {groups.owned.length > 0 && <Group title={`Owned by ${agentName}`} empty="" list={groups.owned} note={`Their usage counts toward ${agentName}.`} onOpen={setCardId} />}
            {groups.targeting.length > 0 && <Group title={`Targets ${agentName}`} empty="" list={groups.targeting} onOpen={setCardId} />}
            {groups.triggeredBy.length > 0 && <Group title={`Set off by ${agentName}`} empty="" list={groups.triggeredBy} onOpen={setCardId} />}
          </div>
        )}
      </DetailsCard>
      {card && <ActionCard action={card} onClose={() => setCardId(null)} onEdit={() => { setCardId(null); setEditing(card); }} />}
      {editing && <ActionForm open action={editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </>
  );
}

/** The Dispatcher's Actions card in Agent details: the actions it made. */
export function DispatcherActionsCard({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { actions } = useActionsList();
  const owned = (actions ?? []).filter((a) => a.owner.kind === 'dispatcher');
  const summary = actions === null ? undefined : owned.length === 0 ? 'none made' : `${owned.length} made by the Dispatcher`;
  return (
    <DetailsCard id="actions" title="Actions" summary={summary} open={open} onToggle={onToggle}>
      {owned.length === 0
        ? <CardNote>Ask the Dispatcher in plain words, for example “every weekday at 9 wake the pm”, and it makes an action.</CardNote>
        : (
          <ul className="px-3">
            {owned.map((a) => <ActionLine key={a.id} action={a} />)}
          </ul>
        )}
    </DetailsCard>
  );
}
