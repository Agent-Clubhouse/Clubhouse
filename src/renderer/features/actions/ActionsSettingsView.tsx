/**
 * Settings > Actions (#2953): every action people and agents made, with
 * filters, a card per action, and the New / edit form. Clubhouse's own
 * actions never show here.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { describeAction, type ActionInput, type ActionView } from '../../../shared/actions';
import { Button } from '../../components/Button';
import { TabList, tabPanelProps } from '../../components/TabList';
import { Toggle } from '../../components/Toggle';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { useAnnexClientStore } from '../../stores/annexClientStore';
import { SettingsPage, settingsError, settingsHelp } from '../settings/SettingsLayout';
import { ActionCard, OutcomeDot, formatWhen, outcomeWords } from './ActionCard';
import { ActionForm } from './ActionForm';
import { ActionOwnerUsage } from './ActionOwnerUsage';
import { actionProjectId, ownerLabel, useActionNames, useActionsList, useActionsNav } from './useActions';

type Filter = 'all' | 'you' | 'agents' | 'off' | 'owners';

const FILTERS: ReadonlyArray<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'you', label: 'By you' },
  { id: 'agents', label: 'By agents' },
  { id: 'off', label: 'Turned off' },
  { id: 'owners', label: 'By owner' },
];

export function filterActions(list: ActionView[], filter: Filter): ActionView[] {
  switch (filter) {
    case 'you': return list.filter((a) => a.owner.kind === 'user');
    case 'agents': return list.filter((a) => a.owner.kind === 'agent' || a.owner.kind === 'dispatcher');
    case 'off': return list.filter((a) => !a.enabled);
    default: return list;
  }
}

/** The empty state's starter patterns: they open the form pre-filled. */
export const STARTERS: ReadonlyArray<{ label: string; input: Partial<ActionInput> }> = [
  {
    label: 'Every weekday, wake an agent with a prompt',
    input: { trigger: { kind: 'schedule', preset: 'weekdays', cron: '0 9 * * 1-5', missed: 'skip' }, steps: [{ kind: 'wake', agentId: '', prompt: '' }] },
  },
  {
    label: 'After an agent sleeps, start a quick agent in its worktree',
    input: { trigger: { kind: 'event', event: 'agent.slept', source: { kind: 'agent', agentId: '' }, delayMinutes: 30 }, steps: [{ kind: 'quick', projectId: '', prompt: '' }] },
  },
  {
    label: 'When one agent wakes, wake another',
    input: { trigger: { kind: 'event', event: 'agent.woke', source: { kind: 'agent', agentId: '' } }, steps: [{ kind: 'wake', agentId: '' }] },
  },
];

function ActionRow({ action, onOpen }: { action: ActionView; onOpen: () => void }) {
  const { names, agents } = useActionNames();
  const [error, setError] = useState<string | null>(null);
  const projectId = actionProjectId(action, (id) => agents.find((a) => a.id === id)?.projectId);
  const project = projectId ? names.project(projectId) : undefined;
  const attention = !action.enabled ? action.offReason : action.problem;
  return (
    <li className="flex items-start gap-3 py-2.5 border-t border-surface-0" data-testid="action-row">
      <Toggle className="mt-0.5" checked={action.enabled} aria-label={action.name}
        onChange={(on) => {
          setError(null);
          window.clubhouse.actions.setEnabled(action.id, on).catch((err: unknown) => {
            // telemetry-exempt: shown on the row; the switch keeps the saved state
            setError(ipcErrorMessage(err));
          });
        }} />
      <button type="button" className="flex-1 min-w-0 text-left cursor-pointer group" onClick={onOpen}>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] text-ctp-text truncate group-hover:underline">{action.name}</span>
          {project && <span className="text-xs text-ctp-overlay1 flex-shrink-0">{project}</span>}
        </div>
        {attention && <div className="text-xs text-ctp-subtext1 truncate" data-testid="action-row-reason">{attention}</div>}
        <div className="text-xs text-ctp-overlay1 truncate">{describeAction(action, names)}</div>
        {error && <div role="alert" className={settingsError}>{error}</div>}
      </button>
      <div className="flex-shrink-0 text-right text-xs w-36">
        <div className="text-ctp-subtext1 truncate">{ownerLabel(action.owner, names)}</div>
        {action.lastRun
          ? (
            <div className="flex items-center justify-end gap-1.5 text-ctp-overlay1">
              <OutcomeDot outcome={action.lastRun.outcome} />
              <span>{outcomeWords(action.lastRun.outcome)}, {formatWhen(action.lastRun.startedAt)}</span>
            </div>
          )
          : <div className="text-ctp-overlay1">Not run yet</div>}
      </div>
    </li>
  );
}

export function ActionsSettingsView() {
  const tabsId = useId();
  const { actions, error, reload } = useActionsList();
  const satellites = useAnnexClientStore((s) => s.satellites);
  const remoteActions = satellites.flatMap((satellite) => {
    const list = satellite.snapshot?.groupProjectActions;
    if (!Array.isArray(list)) return [];
    return list.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string' && typeof a.groupProjectName === 'string' && typeof a.enabled === 'boolean')
      .slice(0, 500).map((action) => ({ ...action, machine: satellite.alias || 'another computer', satelliteId: satellite.id }));
  });
  const [filter, setFilter] = useState<Filter>('all');
  const [cardId, setCardId] = useState<string | null>(null);
  const [form, setForm] = useState<{ action?: ActionView; initial?: Partial<ActionInput>; groupProjectId?: string } | null>(null);
  const pending = useActionsNav((s) => s.pending);
  const setPending = useActionsNav((s) => s.setPending);

  // Another surface asked for a pre-filled form or a card (an agent page, a toast).
  useEffect(() => {
    // Never over a form in progress: what was typed would be lost.
    if (!pending || !actions || form) return;
    if (pending.cardId) setCardId(pending.cardId);
    else if (pending.editId) {
      const a = actions.find((x) => x.id === pending.editId);
      if (a) setForm({ action: a });
    } else setForm({ initial: pending.draft ?? {}, groupProjectId: pending.groupProjectId });
    setPending(null);
  }, [pending, actions, form, setPending]);

  const shown = useMemo(() => filterActions(actions ?? [], filter), [actions, filter]);
  const card = cardId ? actions?.find((a) => a.id === cardId) : undefined;

  return (
    <SettingsPage
      title="Actions"
      description="Workflows that run on a schedule, when something happens, or once. They run whenever Clubhouse is open, even with no project open."
      actions={<Button kind="primary" onClick={() => setForm({})} data-testid="actions-new">New action</Button>}
      testId="actions-settings"
    >
      {error && (
        <div className="mt-4">
          <div role="alert" className={settingsError}>Couldn’t load actions. {error}</div>
          <Button kind="ghost" className="mt-2" onClick={reload}>Try again</Button>
        </div>
      )}
      {actions && actions.length === 0 && filter !== 'owners' && (
        <div className="mt-6" data-testid="actions-empty">
          <p className="text-[13px] text-ctp-text">
            An action does one to three steps when its trigger fires: wake or message an agent, start a quick agent, put an agent to sleep, or notify you.
          </p>
          <p className={`${settingsHelp} mt-1`}>Agents and the Dispatcher can make actions too. Start from one of these:</p>
          <ul className="mt-3">
            {STARTERS.map((s) => (
              <li key={s.label} className="py-2 border-t border-surface-0 flex items-center gap-3">
                <span className="flex-1 text-[13px] text-ctp-text">{s.label}</span>
                <Button kind="ghost" onClick={() => setForm({ initial: s.input })}>Use</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {actions && (
        <>
          <TabList<Filter>
            label="Show actions"
            idPrefix={tabsId}
            value={filter}
            options={FILTERS}
            onChange={setFilter}
            className="flex gap-1 mt-4 mb-2"
            tabClassName={(selected) => `h-7 px-2.5 rounded-md text-xs cursor-pointer ${selected ? 'bg-surface-1 text-ctp-text' : 'text-ctp-subtext0 hover:bg-surface-0'}`}
            testIdPrefix="actions-filter"
          />
          <div {...tabPanelProps(tabsId, filter)}>
            {filter === 'owners' ? <ActionOwnerUsage onOpen={setCardId} /> : shown.length === 0
              ? <div className={`${settingsHelp} py-3 border-t border-surface-0`}>Nothing here.</div>
              : <ul>{shown.map((a) => <ActionRow key={a.id} action={a} onOpen={() => setCardId(a.id)} />)}</ul>}
          </div>
        </>
      )}
      {remoteActions.length > 0 && <section className="mt-5" aria-label="Actions on other computers"><h2 className="text-sm font-medium text-ctp-text">Actions on other computers</h2>
        <ul>{remoteActions.map((action) => <li key={`${action.satelliteId}:${action.id}`} className="py-2 border-t border-surface-0 text-xs text-ctp-subtext1">
          <span className="text-ctp-text">{action.name}</span> · {action.groupProjectName} · Runs on {action.machine}{!action.enabled && ' · Off'}
          {typeof action.description === 'string' && <p>{action.description}</p>}
        </li>)}</ul>
      </section>}
      {card && (
        <ActionCard action={card} onClose={() => setCardId(null)} onEdit={() => { setCardId(null); setForm({ action: card }); }} />
      )}
      <ActionForm open={!!form} action={form?.action} initial={form?.initial} initialGroupProjectId={form?.groupProjectId} onClose={() => setForm(null)} />
    </SettingsPage>
  );
}
