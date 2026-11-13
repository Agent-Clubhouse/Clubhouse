/**
 * Settings › Dispatcher › Lead (#3351): choose one computer's Dispatcher to
 * talk to, for every computer in this Annex Network. Shown only when this
 * computer is in a network with another computer. A person's choice only.
 */

import { useState } from 'react';
import type { DispatcherLeadState, LeadChoice } from '../../../shared/dispatcher-lead';
import { ipcErrorMessage } from '../../utils/ipc-error';
import { SELECT_CLASS } from '../agents/details/AutoSleepRow';
import { useLeadState } from '../dispatcher/leadStore';
import { localNewsLine, outboxLines } from '../dispatcher/FollowerDispatcherView';
import { Button } from '../../components/Button';
import { SettingsField, SettingsSection, settingsError, settingsHelp } from './SettingsLayout';

const NONE = '';

/** "Desk", "Desk and Laptop", "Desk, Laptop and Studio". */
export function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function choiceLabel(choice: LeadChoice): string {
  const notes = [choice.self && 'this computer', !choice.self && !choice.online && 'offline', choice.dispatcherOn === false && 'Dispatcher off'].filter(Boolean);
  return notes.length ? `${choice.name} (${notes.join(', ')})` : choice.name;
}

/** A lead whose Dispatcher is off: followers have no chat to show until it's on. */
export function leadOffWarning(state: DispatcherLeadState): string | null {
  if (!state.lead || state.lead.dispatcherOn !== false) return null;
  return state.lead.self
    ? 'This computer’s Dispatcher is off. Turn it on above, or the other computers have no lead chat to show.'
    : `${state.lead.name}’s Dispatcher is off. The other computers show its chat once it’s on there.`;
}

/** The line under the picker: where this computer stands. */
export function leadStatus(state: DispatcherLeadState): string {
  if (state.role === 'lead') return 'This computer’s Dispatcher leads. The others follow it.';
  if (state.role === 'follower' && state.lead && state.tookBack) return `${state.lead.name} leads, but this computer took back and uses its own Dispatcher.`;
  if (state.role === 'follower' && state.lead) return `This computer follows ${state.lead.name}’s Dispatcher.`;
  if (state.clearedFor) return `${state.clearedFor} left the network, so there’s no lead now. Each computer uses its own Dispatcher.`;
  return 'Each computer uses its own Dispatcher.';
}

/** Which members have the same choice, and which haven't heard it yet. */
export function leadConfirmation(state: DispatcherLeadState): string | null {
  if (!state.changedAt) return null;
  if (state.waitingOn.length === 0) return 'Every computer has this choice.';
  if (state.confirmedBy.length === 0) return `Waiting for ${listNames(state.waitingOn)} to get this choice.`;
  return `${listNames(state.confirmedBy)} ${state.confirmedBy.length === 1 ? 'has' : 'have'} this choice. Waiting for ${listNames(state.waitingOn)}.`;
}

export function LeadSection() {
  const state = useLeadState();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!state?.available) return null;

  const act = async (action: () => Promise<unknown>, failed: string) => {
    setSaving(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      // telemetry-exempt: shown under the picker, which keeps the saved choice.
      setError(`${failed} ${ipcErrorMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };
  const choose = (machine: string | null) => act(() => window.clubhouse.dispatcher.setLead(machine), 'Couldn’t change the lead.');
  const confirmation = leadConfirmation(state);

  return (
    <SettingsSection title="Lead">
      <SettingsField
        label="Lead"
        htmlFor="dispatcher-lead"
        help="Talk to one computer’s Dispatcher from every computer in your Annex Network. The others keep doing work on their own computer."
      >
        <select
          id="dispatcher-lead"
          className={SELECT_CLASS}
          value={state.lead?.machine ?? NONE}
          disabled={saving || !state.canChoose}
          onChange={(e) => void choose(e.target.value === NONE ? null : e.target.value)}
          data-testid="dispatcher-lead"
        >
          <option value={NONE}>None</option>
          {state.choices.map((c) => <option key={c.machine} value={c.machine}>{choiceLabel(c)}</option>)}
        </select>
      </SettingsField>
      <p className={`${settingsHelp} mt-1.5`} role="status" data-testid="dispatcher-lead-status">{leadStatus(state)}</p>
      {(() => {
        // After Take back the pane is gone, so what still waits for the lead, or didn't make it, is said here.
        if (!state.tookBack || !state.lead) return null;
        const { waiting, problem } = outboxLines(state.outbox, state.lead.name);
        const local = localNewsLine(state.localNews, true);
        if (!waiting && !problem && !local) return null;
        return (
          <div className={`${settingsHelp} mt-1.5 flex flex-col gap-1`} data-testid="dispatcher-lead-outbox">
            {waiting && <p>{waiting}</p>}
            {problem && <p>{problem}</p>}
            {local && <p>{local}</p>}
            {(problem || local) && (
              <Button className="self-start" disabled={saving} onClick={() => void act(() => window.clubhouse.dispatcher.dismissLeadNotice(), 'Couldn’t dismiss it.')} data-testid="dispatcher-lead-outbox-dismiss">
                Dismiss
              </Button>
            )}
          </div>
        );
      })()}
      {state.tookBack && state.lead && (
        <Button className="mt-1.5" disabled={saving} onClick={() => void act(() => window.clubhouse.dispatcher.followAgain(), 'Couldn’t follow again.')} data-testid="dispatcher-lead-follow-again">
          Follow {state.lead.name} again
        </Button>
      )}
      {confirmation && <p className={`${settingsHelp} mt-1`} data-testid="dispatcher-lead-confirmation">{confirmation}</p>}
      {leadOffWarning(state) && <p className={`${settingsError} mt-1`} role="alert" data-testid="dispatcher-lead-off">{leadOffWarning(state)}</p>}
      {error && <p className={`${settingsError} mt-1.5`} role="alert" data-testid="dispatcher-lead-error">{error}</p>}
    </SettingsSection>
  );
}
