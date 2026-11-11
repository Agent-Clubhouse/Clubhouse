/**
 * Agent settings > Actions (#2954), and every agent's Actions card in
 * Agent details: the actions that involve one agent, in three groups.
 */

import { useState } from 'react';
import { describeAction, type ActionInput, type ActionView } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { settingsHelp } from '../settings/SettingsLayout';
import { CardNote, DetailsCard } from '../agents/details/DetailsCard';
import { ActionCard, OutcomeDot } from './ActionCard';
import { ActionForm } from './ActionForm';
import { openActionsSettings, useActionNames, useActionsList } from './useActions';

export interface AgentActionGroups {
  /** Actions with a step that wakes, messages or otherwise acts on this agent. */
  targeting: ActionView[];
  /** Actions this agent's events set off (itself, or any agent in its project). */
  triggeredBy: ActionView[];
  /** Actions this agent made; usage counts toward it. */
  owned: ActionView[];
}

export function agentActionGroups(list: ActionView[], agentId: string, projectId: string | undefined): AgentActionGroups {
  const targets = (a: ActionView) => a.steps.some((s) => (s.kind === 'quick' ? s.worktreeAgentId === agentId : 'agentId' in s && s.agentId === agentId));
  const triggers = (a: ActionView) => a.trigger.kind === 'event'
    && ((a.trigger.source.kind === 'agent' && a.trigger.source.agentId === agentId)
      || (a.trigger.source.kind === 'project' && !!projectId && a.trigger.source.projectId === projectId));
  return {
    targeting: list.filter(targets),
    triggeredBy: list.filter(triggers),
    owned: list.filter((a) => a.owner.kind === 'agent' && a.owner.agentId === agentId),
  };
}

function ActionLine({ action, onOpen }: { action: ActionView; onOpen?: (id: string) => void }) {
  const { names } = useActionNames();
  return (
    <li className="py-2 border-t border-surface-0">
      <button type="button" className="w-full text-left cursor-pointer group" onClick={() => onOpen ? onOpen(action.id) : openActionsSettings({ cardId: action.id })} data-testid="agent-action-row">
        <div className="flex items-center gap-2">
          {action.lastRun && <OutcomeDot outcome={action.lastRun.outcome} />}
          <span className="text-[13px] text-ctp-text truncate group-hover:underline">{action.name}</span>
          {!action.enabled && <span className="text-xs text-ctp-overlay1">Off</span>}
        </div>
        <div className="text-xs text-ctp-overlay1 truncate">{describeAction(action, names)}</div>
      </button>
    </li>
  );
}

function Group({ title, empty, list, note, onOpen }: { title: string; empty: string; list: ActionView[]; note?: string; onOpen?: (id: string) => void }) {
  return (
    <section className="mt-5">
      <h3 className="text-[13px] font-semibold text-ctp-text">{title}</h3>
      {note && list.length > 0 && <div className={settingsHelp}>{note}</div>}
      {list.length === 0
        ? <div className={`${settingsHelp} mt-1`}>{empty}</div>
        : <ul className="mt-1">{list.map((a) => <ActionLine key={a.id} action={a} onOpen={onOpen} />)}</ul>}
    </section>
  );
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
          <Group title={`Act on ${agentName}`} empty={`No action acts on ${agentName}.`} list={groups.targeting} />
          <Group title={`Set off by ${agentName}`} empty={`Nothing ${agentName} does sets off an action.`} list={groups.triggeredBy} />
          <Group title={`Made by ${agentName}`} empty={`${agentName} hasn’t made any actions.`} list={groups.owned} note={`Their usage counts toward ${agentName}.`} />
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
        {actions && related === 0 && <CardNote>No actions are made by, act on or are set off by {agentName}.</CardNote>}
        {actions && related > 0 && (
          <div className="px-3 pb-1">
            {groups.owned.length > 0 && <Group title={`Made by ${agentName}`} empty="" list={groups.owned} note={`Their usage counts toward ${agentName}.`} onOpen={setCardId} />}
            {groups.targeting.length > 0 && <Group title={`Act on ${agentName}`} empty="" list={groups.targeting} onOpen={setCardId} />}
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
